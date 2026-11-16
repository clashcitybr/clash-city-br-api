require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");
const { PrismaClient } = require("@prisma/client");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const path = require("path");
const fs = require("fs");
const webpush = require("web-push");
const liga = require("./liga-guerras");

// Configura VAPID
webpush.setVapidDetails(
    'mailto:admin@clashcitybr.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

// Inscrições de notificação push. Ficam na memória para uso rápido e são
// gravadas num arquivo a cada mudança — assim sobrevivem quando o servidor
// reinicia (antes, todo reinício apagava quem tinha ativado as notificações).
const ARQUIVO_PUSH = path.join(__dirname, "push-subscriptions.json");

function carregarInscricoesPush() {
    try {
        const dados = JSON.parse(fs.readFileSync(ARQUIVO_PUSH, "utf8"));
        return Array.isArray(dados) ? dados.filter(s => s && s.endpoint) : [];
    } catch (err) {
        return [];   // arquivo ainda não existe (primeira vez) ou está corrompido
    }
}

function salvarInscricoesPush() {
    try {
        // Grava num temporário e renomeia: se o servidor cair no meio da
        // escrita, o arquivo antigo continua inteiro.
        const temporario = `${ARQUIVO_PUSH}.tmp`;
        fs.writeFileSync(temporario, JSON.stringify(pushSubscriptions));
        fs.renameSync(temporario, ARQUIVO_PUSH);
    } catch (err) {
        console.error("[Push] Não foi possível salvar as inscrições:", err.message);
    }
}

let pushSubscriptions = carregarInscricoesPush();

// ============================================================
// DEFESAS DE GUERRA (para o card "Muralha do Mês")
// ============================================================
// A API da guerra informa, para cada membro, o melhor ataque que ele tomou
// (bestOpponentAttack). Quando a guerra acaba, isso é somado por mês num
// arquivo — sem mexer no banco. Guerras da Liga não passam por aqui.
const ARQUIVO_DEFESAS = path.join(__dirname, "defesas.json");

function carregarDefesas() {
    try {
        const dados = JSON.parse(fs.readFileSync(ARQUIVO_DEFESAS, "utf8"));
        return dados && typeof dados === "object" ? dados : {};
    } catch (err) {
        return {};   // ainda não existe (primeira vez)
    }
}

let defesas = carregarDefesas();

// Regra da Muralha: só conta como DEFESA a base que tomou 0, 1 ou 2 estrelas.
// Tomou 3 estrelas = a defesa caiu, não soma nada.
// Os meses gravados antes dessa regra só têm totais; aqui eles são separados.
// 3 estrelas sempre é 100% de destruição, então estrelas e destruição das que
// seguraram saem exatas; só a quantidade fica estimada (pega a menor possível)
// quando o jogador teve defesas misturadas.
function migrarDefesasAntigas() {
    let mudou = false;
    for (const doMes of Object.values(defesas)) {
        for (const j of Object.values(doMes?.jogadores || {})) {
            if (j.seguradas !== undefined) continue;
            const d = j.defesas || 0, S = j.estrelasTomadas || 0, D = j.destruicaoTomada || 0, p = j.defesasPerfeitas || 0;
            let h = null;
            for (let tent = p; tent <= d; tent++) {           // menor quantidade que fecha a conta
                const caidas = d - tent, estrelas = S - 3 * caidas, destr = D - 100 * caidas;
                const comEstrela = tent - p;
                if (estrelas < comEstrela || estrelas > 2 * comEstrela) continue;
                if (destr < 0 || (tent > 0 && destr >= 100 * tent)) continue;
                h = tent; break;
            }
            if (h === null) h = p;
            const caidas = d - h;
            j.seguradas = h;
            j.estrelasSeguradas = Math.max(0, S - 3 * caidas);
            j.destruicaoSegurada = Math.max(0, D - 100 * caidas);
            mudou = true;
        }
    }
    if (mudou) salvarDefesas();
}

function salvarDefesas() {
    try {
        const temporario = `${ARQUIVO_DEFESAS}.tmp`;
        fs.writeFileSync(temporario, JSON.stringify(defesas));
        fs.renameSync(temporario, ARQUIVO_DEFESAS);
    } catch (err) {
        console.error("[Defesas] Não foi possível salvar:", err.message);
    }
}

migrarDefesasAntigas();

// Soma as defesas de uma guerra encerrada no mês dela. Cada guerra entra uma vez só.
// Conta CADA ataque que a base sofreu, na ordem em que aconteceram:
//   - 0, 1 ou 2 estrelas = defesa segurada;
//   - o ataque que deu 3 estrelas = a base caiu, e daí pra frente NADA mais conta
//     (quem ataca depois disso é só pra bônus/limpeza, não é defesa de verdade).
function registrarDefesasDaGuerra(dadosGuerra, warId, mes) {
    const doMes = defesas[mes] || (defesas[mes] = { guerras: [], jogadores: {} });
    if (doMes.guerras.includes(warId)) return;

    // Ataques do adversário contra a nossa base, agrupados por defensor
    const nossos = new Map((dadosGuerra.clan?.members || []).map(p => [p.tag, p]));
    const ataquesPorBase = new Map();
    for (const inimigo of dadosGuerra.opponent?.members || []) {
        for (const atq of inimigo.attacks || []) {
            if (!nossos.has(atq.defenderTag)) continue;
            if (!ataquesPorBase.has(atq.defenderTag)) ataquesPorBase.set(atq.defenderTag, []);
            ataquesPorBase.get(atq.defenderTag).push(atq);
        }
    }

    // Se a API não mandou os ataques do adversário, usa só o melhor ataque (regra antiga)
    if (ataquesPorBase.size === 0) {
        for (const p of nossos.values()) {
            if (p.opponentAttacks > 0 && p.bestOpponentAttack) ataquesPorBase.set(p.tag, [p.bestOpponentAttack]);
        }
    }

    let contadas = 0;
    for (const [tag, ataques] of ataquesPorBase) {
        const p = nossos.get(tag);
        const j = doMes.jogadores[tag] || (doMes.jogadores[tag] = {
            nome: p.name, cv: p.townhallLevel,
            defesas: 0, estrelasTomadas: 0, destruicaoTomada: 0, defesasPerfeitas: 0,
            seguradas: 0, estrelasSeguradas: 0, destruicaoSegurada: 0
        });
        j.nome = p.name;
        j.cv = p.townhallLevel;

        ataques.sort((x, y) => (x.order || 0) - (y.order || 0));
        for (const atq of ataques) {
            const estrelas = atq.stars || 0;
            const destruicao = atq.destructionPercentage || 0;
            j.defesas += 1;                                  // ataques que contaram
            j.estrelasTomadas += estrelas;
            j.destruicaoTomada += destruicao;
            contadas++;
            if (estrelas >= 3) break;                        // caiu: o resto não conta
            j.seguradas = (j.seguradas || 0) + 1;
            j.estrelasSeguradas = (j.estrelasSeguradas || 0) + estrelas;
            j.destruicaoSegurada = (j.destruicaoSegurada || 0) + destruicao;
            if (estrelas === 0) j.defesasPerfeitas += 1;
        }
    }

    doMes.guerras.push(warId);
    salvarDefesas();
    console.log(`[Defesas] Guerra ${warId}: ${contadas} ataque(s) contados em ${mes}.`);
}
// ============================================================
// HISTÓRICO DETALHADO DE GUERRAS (aba "Últimas Guerras" do perfil)
// Quando uma guerra termina, guarda o que cada membro fez nela:
// ataques (estrelas, %, CV do alvo) e a defesa (quantos ataques segurou
// até tomar 3 estrelas). Arquivo próprio, sem mexer no banco.
// ============================================================
const ARQUIVO_GUERRAS_DETALHE = path.join(__dirname, "guerras-detalhe.json");
const MAX_GUERRAS_DETALHE = 80;

function carregarGuerrasDetalhe() {
    try {
        const dados = JSON.parse(fs.readFileSync(ARQUIVO_GUERRAS_DETALHE, "utf8"));
        return dados && typeof dados === "object" ? dados : {};
    } catch (err) {
        return {};
    }
}

let guerrasDetalhe = carregarGuerrasDetalhe();

function salvarGuerrasDetalhe() {
    try {
        const temporario = `${ARQUIVO_GUERRAS_DETALHE}.tmp`;
        fs.writeFileSync(temporario, JSON.stringify(guerrasDetalhe));
        fs.renameSync(temporario, ARQUIVO_GUERRAS_DETALHE);
    } catch (err) {
        console.error("[Guerras] Não foi possível salvar o detalhe:", err.message);
    }
}

// Ataques sofridos em ordem: conta quantos a base segurou até cair (3 estrelas).
// "fresh" = caiu logo no 1º ataque, ou seja, a vila não teve defesa.
function resumirDefesa(ataquesContra) {
    if (!ataquesContra.length) return { atacada: false };
    const ordenados = [...ataquesContra].sort((a, b) => (a.order || 0) - (b.order || 0));
    let seguradas = 0, caiuNo = null, melhorEstrelas = 0, melhorDestruicao = 0;
    for (let i = 0; i < ordenados.length; i++) {
        const estrelas = ordenados[i].stars || 0;
        const destruicao = ordenados[i].destructionPercentage || 0;
        if (estrelas > melhorEstrelas || (estrelas === melhorEstrelas && destruicao > melhorDestruicao)) {
            melhorEstrelas = estrelas; melhorDestruicao = destruicao;
        }
        if (estrelas >= 3) { caiuNo = i + 1; break; }
        seguradas++;
    }
    return {
        atacada: true,
        ataquesSofridos: ordenados.length,
        seguradas,
        caiuNo,
        fresh: caiuNo === 1,
        melhorEstrelas,
        melhorDestruicao
    };
}

function registrarGuerraDetalhada(dadosGuerra, warId) {
    if (!warId || guerrasDetalhe[warId]) return false;

    const nossos = dadosGuerra.clan?.members || [];
    const inimigos = dadosGuerra.opponent?.members || [];
    const infoInimigo = new Map(inimigos.map(m => [m.tag, m]));
    const tagsNossas = new Set(nossos.map(m => m.tag));

    const contraNos = new Map();   // defensor (nosso) -> ataques sofridos
    for (const inimigo of inimigos) {
        for (const atq of inimigo.attacks || []) {
            if (!tagsNossas.has(atq.defenderTag)) continue;
            if (!contraNos.has(atq.defenderTag)) contraNos.set(atq.defenderTag, []);
            contraNos.get(atq.defenderTag).push(atq);
        }
    }
    const temAtaquesInimigos = contraNos.size > 0;

    const membros = {};
    for (const p of nossos) {
        let defesa;
        if (temAtaquesInimigos) {
            defesa = resumirDefesa(contraNos.get(p.tag) || []);
        } else if (p.opponentAttacks > 0 && p.bestOpponentAttack) {
            // Sem a lista de ataques do adversário: só dá pra saber o pior resultado
            defesa = {
                atacada: true, parcial: true,
                ataquesSofridos: p.opponentAttacks,
                melhorEstrelas: p.bestOpponentAttack.stars || 0,
                melhorDestruicao: p.bestOpponentAttack.destructionPercentage || 0
            };
        } else {
            defesa = { atacada: false };
        }

        membros[p.tag] = {
            nome: p.name,
            cv: p.townhallLevel,
            posicao: p.mapPosition,
            ataques: (p.attacks || [])
                .sort((a, b) => (a.order || 0) - (b.order || 0))
                .map(a => {
                    const alvo = infoInimigo.get(a.defenderTag);
                    return {
                        estrelas: a.stars || 0,
                        destruicao: a.destructionPercentage || 0,
                        cvAlvo: alvo?.townhallLevel ?? null,
                        posicaoAlvo: alvo?.mapPosition ?? null
                    };
                }),
            defesa
        };
    }

    const nos = dadosGuerra.clan || {}, eles = dadosGuerra.opponent || {};
    let resultado = "empate";
    if ((nos.stars || 0) !== (eles.stars || 0)) resultado = (nos.stars || 0) > (eles.stars || 0) ? "vitoria" : "derrota";
    else if ((nos.destructionPercentage || 0) !== (eles.destructionPercentage || 0))
        resultado = (nos.destructionPercentage || 0) > (eles.destructionPercentage || 0) ? "vitoria" : "derrota";

    guerrasDetalhe[warId] = {
        warId,
        inicio: dadosGuerra.preparationStartTime || null,
        fim: dadosGuerra.endTime || null,
        tamanho: dadosGuerra.teamSize || nossos.length,
        ataquesPorMembro: dadosGuerra.attacksPerMember || 2,
        resultado,
        placar: {
            nos: { estrelas: nos.stars || 0, destruicao: nos.destructionPercentage || 0 },
            eles: { estrelas: eles.stars || 0, destruicao: eles.destructionPercentage || 0 }
        },
        adversario: { tag: eles.tag || null, nome: eles.name || null, escudo: eles.badgeUrls?.small || null },
        membros
    };

    // Mantém só as guerras mais recentes
    const ids = Object.keys(guerrasDetalhe).sort();
    while (ids.length > MAX_GUERRAS_DETALHE) delete guerrasDetalhe[ids.shift()];

    salvarGuerrasDetalhe();
    console.log(`[Guerras] Guerra ${warId} registrada em detalhe (${nossos.length} membros).`);
    return true;
}

// Resumo pessoal quando a guerra acaba: ataques + defesa de cada conta seguida
async function avisarFimDeGuerraPessoal(warId) {
    const g = guerrasDetalhe[warId];
    if (!g) return;
    const nomeResultado = { vitoria: "Vitória", derrota: "Derrota", empate: "Empate" }[g.resultado] || "";
    const avisos = Object.entries(g.membros).map(([tag, m]) => {
        const estrelas = m.ataques.reduce((n, a) => n + a.estrelas, 0);
        const perdidos = Math.max(0, (g.ataquesPorMembro || 2) - m.ataques.length);
        const partes = [m.ataques.length
            ? `${estrelas}★ em ${m.ataques.length} ${m.ataques.length === 1 ? "ataque" : "ataques"}`
            : "não atacou"];
        if (perdidos && m.ataques.length) partes.push(`perdeu ${perdidos}`);
        const defesa = textoDefesaCurto(m.defesa);
        if (defesa) partes.push(defesa);
        return { tag, nome: m.nome, linha: partes.join(" · ") };
    });
    await enviarPushPessoal(avisos, {
        tipo: "resumo",
        titulo: `🏁 Guerra contra ${g.adversario?.nome || "o adversário"} acabou${nomeResultado ? ` — ${nomeResultado}` : ""}`,
        umaConta: a => `${a.nome}: ${a.linha}`,
        variasContas: lista => lista.map(a => `${a.nome}: ${a.linha}`).join("\n")
    });
}

// Sequência de 3★: avisa a cada 5 seguidos (5, 10, 15...)
async function avisarSequenciaTriplas(tag, nome) {
    const ultimos = await prisma.ataqueRegistrado.findMany({
        where: { tagJogador: tag }, orderBy: { createdAt: "desc" }, take: 60
    });
    let seguidos = 0;
    while (seguidos < ultimos.length && ultimos[seguidos].estrelas === 3) seguidos++;
    if (seguidos < 5 || seguidos % 5 !== 0) return;
    await enviarPushPessoal([{ tag, nome, seguidos }], {
        tipo: "sequencia",
        titulo: "🔥 Sequência de 3★!",
        umaConta: a => `${a.nome} fez ${a.seguidos} ataques seguidos com 3 estrelas!`,
        variasContas: lista => lista.map(a => `${a.nome}: ${a.seguidos} ataques seguidos com 3★`).join("\n")
    });
}
console.log(`[Push] ${pushSubscriptions.length} inscrição(ões) carregada(s) do arquivo.`);

async function enviarNotificacaoPush(titulo, corpo, icone = '/img/Perfil_COC-removebg-preview.png') {
    const payload = JSON.stringify({ titulo, corpo, icone });
    const mortas = [];

    for (const sub of pushSubscriptions) {
        if (!querAviso(sub, "cla")) continue;   // desligou os avisos gerais do clã
        try {
            await webpush.sendNotification(sub, payload);
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                mortas.push(sub.endpoint);
            }
        }
    }

    // Remove inscrições expiradas
    if (mortas.length > 0) {
        pushSubscriptions = pushSubscriptions.filter(s => !mortas.includes(s.endpoint));
        salvarInscricoesPush();
        console.log(`[Push] ${mortas.length} inscrições expiradas removidas.`);
    }
}

// ------------------------------------------------------------
// PUSH PESSOAL ("Meu Painel"): cada celular pode seguir uma ou mais
// contas (tags). Os avisos de uma conta só vão pra quem segue ela, e
// quem segue várias contas recebe tudo numa notificação só.
// ------------------------------------------------------------
const URL_MEU_PAINEL = "https://clashcitybr.github.io/controle-cla/meu-painel.html";

function normalizarTagsSeguidas(lista) {
    if (!Array.isArray(lista)) return [];
    const limpas = lista
        .map(t => String(t || "").trim().toUpperCase())
        .map(t => (t.startsWith("#") ? t : `#${t}`))
        .filter(t => /^#[0-9A-Z]{3,15}$/.test(t));
    return [...new Set(limpas)].slice(0, 10);
}

// Tipos de aviso que cada celular pode ligar/desligar no Meu Painel.
// Sem preferência gravada (inscrições antigas) = tudo ligado.
const TIPOS_AVISO = ["pendente", "resumo", "sequencia", "cla"];

function normalizarPrefs(obj) {
    const prefs = {};
    for (const t of TIPOS_AVISO) prefs[t] = !(obj && obj[t] === false);
    return prefs;
}
const querAviso = (sub, tipo) => !(sub.prefs && sub.prefs[tipo] === false);

// avisos: [{ tag, nome, ... }]. Para cada celular junta os avisos das contas
// que ele segue e monta o texto com umaConta(aviso) ou variasContas(avisos).
async function enviarPushPessoal(avisos, { tipo, titulo, umaConta, variasContas, url = URL_MEU_PAINEL }) {
    if (!avisos.length) return 0;
    const porTag = new Map(avisos.map(a => [a.tag, a]));
    const mortas = [];
    let enviados = 0;

    for (const sub of pushSubscriptions) {
        if (tipo && !querAviso(sub, tipo)) continue;   // o dono desligou esse tipo de aviso
        const meus = (sub.tags || []).map(t => porTag.get(t)).filter(Boolean);
        if (!meus.length) continue;
        const corpo = meus.length === 1 ? umaConta(meus[0]) : variasContas(meus);
        const payload = JSON.stringify({
            titulo: typeof titulo === "function" ? titulo(meus) : titulo,
            corpo,
            icone: '/img/Perfil_COC-removebg-preview.png',
            url
        });
        try {
            await webpush.sendNotification(sub, payload);
            enviados++;
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) mortas.push(sub.endpoint);
        }
    }

    if (mortas.length > 0) {
        pushSubscriptions = pushSubscriptions.filter(s => !mortas.includes(s.endpoint));
        salvarInscricoesPush();
    }
    if (enviados) console.log(`[Push pessoal] "${typeof titulo === "function" ? "aviso" : titulo}" enviado para ${enviados} celular(es).`);
    return enviados;
}

function juntarNomes(nomes) {
    if (nomes.length <= 1) return nomes.join("");
    return `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
}

function textoDefesaCurto(d) {
    if (!d || d.parcial) return null;
    if (!d.atacada) return "🛡️ não foi atacado";
    if (d.fresh) return "💥 tomou PT fresh";
    if (d.caiuNo === null) return `🛡️ segurou ${d.seguradas} e não tomou PT`;
    return `🛡️ segurou ${d.seguradas}, caiu no ${d.caiuNo}º ataque`;
}

const prisma = new PrismaClient();
const app = express();

// ============================================================
// MIDDLEWARE DE AUTENTICAÇÃO ADMIN
// ============================================================
const autenticarAdmin = (req, res, next) => {
    const senha = req.headers['x-admin-key'];
    if (!senha || senha !== process.env.ADMIN_KEY) {
        return res.status(401).json({ erro: "Não autorizado. Chave admin inválida." });
    }
    next();
};

// ============================================================
// CRITÉRIO ÚNICO DO RANKING — usado no fechamento do mês, no
// histórico e no Hall da Fama, igual ao ranking ao vivo do site:
//   1º mais guerras (valoriza quem participa)
//   2º maior média de estrelas
//   3º maior média de destruição
//   4º maior Centro de Vila
// Devolve só quem guerreou no mês, já com a posição recalculada.
// ============================================================
function ordenarRanking(lista) {
    const media = (total, guerras, guardada) =>
        (guerras > 0 && typeof total === "number") ? total / guerras : (guardada || 0);

    return (Array.isArray(lista) ? lista : [])
        .filter(j => j && (j.guerras ?? 1) > 0)
        .map(j => ({
            j,
            guerras: j.guerras || 0,
            estrelas: media(j.totalEstrelas, j.guerras, j.mediaEstrelas),
            // a média de destruição guardada já vem dividida por 2 (2 ataques)
            destruicao: media(j.totalDestruicao, j.guerras, (j.mediaPorcentagem || 0) * 2),
            cv: Number(j.cv) || 0
        }))
        .sort((a, b) =>
            b.guerras - a.guerras ||
            b.estrelas - a.estrelas ||
            b.destruicao - a.destruicao ||
            b.cv - a.cv)
        .map((x, i) => ({ ...x.j, posicao: i + 1 }));
}

// Soma uma guerra no histórico do mês em que ela começou (mês já fechado)
async function somarGuerraNoHistorico(dadosGuerra, warId, mes) {
    const temporada = await prisma.temporada.findUnique({ where: { mes } });
    if (!temporada) return;
    const snapshot = Array.isArray(temporada.snapshot) ? temporada.snapshot : [];
    let mudou = false;

    for (const p of dadosGuerra.clan.members) {
        const membro = await prisma.membro.findUnique({ where: { tag: p.tag } });
        if (membro?.guerrasIds?.includes(warId)) continue; // já somada antes

        const est = (p.attacks || []).reduce((s, a) => s + a.stars, 0);
        const des = (p.attacks || []).reduce((s, a) => s + a.destructionPercentage, 0);

        let e = snapshot.find(x => x.tag === p.tag);
        if (!e) {
            e = {
                tag: p.tag, nome: p.name, cv: p.townhallLevel, status: "titular",
                totalEstrelas: 0, totalDestruicao: 0, guerras: 0
            };
            snapshot.push(e);
        }
        e.totalEstrelas += est;
        e.totalDestruicao += des;
        e.guerras += 1;
        e.mediaEstrelas = +(e.totalEstrelas / e.guerras).toFixed(2);
        e.mediaPorcentagem = +((e.totalDestruicao / e.guerras) / 2).toFixed(2);

        if (membro) {
            await prisma.membro.update({ where: { tag: p.tag }, data: { guerrasIds: { push: warId } } });
        }
        mudou = true;
    }

    if (!mudou) return;
    await prisma.temporada.update({ where: { mes }, data: { snapshot: ordenarRanking(snapshot) } });
    console.log(`[HISTÓRICO] Guerra ${warId} somada em ${mes}.`);
}

// ============================================================
// WHATSAPP COM BAILEYS
// ============================================================
let sock = null;
let tentandoConectar = false;

async function conectarWhatsApp() {
    if (tentandoConectar) return;
    tentandoConectar = true;

    const authDir = path.join(__dirname, "wwebjs_auth_baileys");
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: require("pino")({ level: "silent" }),
        browser: ["Clash City BR", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("--- ESCANEIE O QR CODE ABAIXO ---");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            console.log("WhatsApp desconectado. Reconectando:", shouldReconnect);
            tentandoConectar = false;

            if (shouldReconnect) {
                setTimeout(conectarWhatsApp, 5000);
            }
        } else if (connection === "open") {
            console.log("WhatsApp do Clã está conectado e pronto para enviar alertas!");
            tentandoConectar = false;
        }
    });
}

async function enviarMensagemWhatsApp(mensagem) {
    if (!sock) {
        console.error("WhatsApp não está conectado.");
        return;
    }

    try {
        const groups = await sock.groupFetchAllParticipating();
        const grupo = Object.values(groups).find(g => g.subject.includes("CLASH CITY BR"));

        if (grupo) {
            await sock.sendMessage(grupo.id, { text: mensagem });
            console.log("Mensagem enviada para o grupo!");
        } else {
            console.error("Grupo CLASH CITY BR não encontrado.");
        }
    } catch (err) {
        console.error("Erro ao enviar mensagem WhatsApp:", err.message);
    }
}

// ============================================================
// MIDDLEWARES
// ============================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning, x-admin-key');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));

app.use(express.json());

const api_base = "https://api.clashofclans.com/v1";
const clan_tag = encodeURIComponent("#GUPJU0L2");

// Rotas da Liga de Clãs (CWL): GET /liga/guerras/:cla
liga.registrarRotasLiga(app, {
    axios,
    apiBase: api_base,
    prisma,
    enviarMensagemWhatsApp,
    enviarNotificacaoPush,
    autenticarAdmin
});

// ============================================================
// ROTAS DE NOTIFICAÇÃO PUSH
// ============================================================
app.get("/vapid-public-key", (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post("/subscribe", (req, res) => {
    const subscription = req.body;
    if (!subscription || typeof subscription.endpoint !== "string") {
        return res.status(400).json({ erro: "Inscrição inválida." });
    }
    // "tags" (opcional) = contas que este celular segue no Meu Painel
    const temTags = Array.isArray(subscription.tags);
    const tags = temTags ? normalizarTagsSeguidas(subscription.tags) : null;
    // "prefs" (opcional) = quais tipos de aviso este celular quer receber
    const temPrefs = subscription.prefs && typeof subscription.prefs === "object";
    const prefs = temPrefs ? normalizarPrefs(subscription.prefs) : null;

    const jaExiste = pushSubscriptions.find(s => s.endpoint === subscription.endpoint);
    if (!jaExiste) {
        const nova = { endpoint: subscription.endpoint, keys: subscription.keys, expirationTime: subscription.expirationTime ?? null };
        if (temTags) nova.tags = tags;
        if (temPrefs) nova.prefs = prefs;
        pushSubscriptions.push(nova);
        salvarInscricoesPush();
        console.log(`[Push] Nova inscrição${temTags ? ` (${tags.length} conta(s))` : ""}. Total: ${pushSubscriptions.length}`);
    } else if (temTags || temPrefs) {
        if (temTags) jaExiste.tags = tags;
        if (temPrefs) jaExiste.prefs = prefs;
        if (subscription.keys) jaExiste.keys = subscription.keys;
        salvarInscricoesPush();
    }
    const atual = jaExiste || pushSubscriptions[pushSubscriptions.length - 1];
    res.status(201).json({ mensagem: "Inscrito com sucesso!", contas: atual?.tags ?? [], prefs: normalizarPrefs(atual?.prefs) });
});

// O Meu Painel pergunta o que este celular segue e quais avisos estão ligados.
// Vai por POST pra não colocar o endpoint (que é longo) na URL.
app.post("/subscribe/consultar", (req, res) => {
    const { endpoint } = req.body || {};
    if (typeof endpoint !== "string") return res.status(400).json({ erro: "Endpoint inválido." });
    const sub = pushSubscriptions.find(s => s.endpoint === endpoint);
    if (!sub) return res.json({ inscrito: false, contas: [], prefs: normalizarPrefs(null) });
    res.json({ inscrito: true, contas: sub.tags || [], prefs: normalizarPrefs(sub.prefs) });
});

app.delete("/subscribe", (req, res) => {
    const { endpoint } = req.body || {};
    pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
    salvarInscricoesPush();
    res.json({ mensagem: "Inscrição removida." });
});

// ============================================================
// USO DO APP: contador anônimo de páginas abertas
// O site manda { pagina, aparelho, app } ao abrir cada página.
// "aparelho" é um código aleatório criado no celular (não identifica
// a pessoa). Guarda só os últimos 120 dias, num arquivo próprio.
// ============================================================
const ARQUIVO_USO = path.join(__dirname, "uso.json");
const PAGINAS_USO = new Set(["home", "ranking", "membros", "capital", "ataques", "historico", "perfil", "mapa", "meu-painel", "liga"]);
const DIAS_USO = 120;

function carregarUso() {
    try {
        const d = JSON.parse(fs.readFileSync(ARQUIVO_USO, "utf8"));
        return d && typeof d.dias === "object" ? d : { dias: {} };
    } catch (_) { return { dias: {} }; }
}
let uso = carregarUso();
let usoSujo = false;

// Grava no máximo 1 vez por minuto (não fica escrevendo no disco a cada visita)
setInterval(() => {
    if (!usoSujo) return;
    usoSujo = false;
    const dias = Object.keys(uso.dias).sort();
    while (dias.length > DIAS_USO) delete uso.dias[dias.shift()];
    try {
        const tmp = `${ARQUIVO_USO}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(uso));
        fs.renameSync(tmp, ARQUIVO_USO);
    } catch (err) { console.error("[Uso] Não foi possível salvar:", err.message); }
}, 60 * 1000);

app.post("/uso", (req, res) => {
    const { pagina, aparelho, app: noApp } = req.body || {};
    if (!PAGINAS_USO.has(pagina) || typeof aparelho !== "string" || !/^[a-z0-9]{8,32}$/.test(aparelho)) {
        return res.status(400).json({ erro: "Dados inválidos." });
    }
    const dia = hojeBR();
    const doDia = uso.dias[dia] || (uso.dias[dia] = {});
    const pg = doDia[pagina] || (doDia[pagina] = { aberturas: 0, aparelhos: {} });
    if (pg.aberturas < 100000) pg.aberturas++;
    if (Object.keys(pg.aparelhos).length < 2000 || pg.aparelhos[aparelho]) pg.aparelhos[aparelho] = noApp ? "app" : "web";
    usoSujo = true;
    res.status(204).end();
});

// Resumo para o líder (pede a senha admin)
app.get("/uso/resumo", autenticarAdmin, (req, res) => {
    const resumir = qtdDias => {
        const limite = new Date(Date.now() - (qtdDias - 1) * 86400000).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
        const paginas = {};
        const todos = new Map();
        for (const [dia, doDia] of Object.entries(uso.dias)) {
            if (dia < limite) continue;
            for (const [pagina, pg] of Object.entries(doDia)) {
                const r = paginas[pagina] || (paginas[pagina] = { aberturas: 0, aparelhos: new Set() });
                r.aberturas += pg.aberturas;
                for (const [ap, tipo] of Object.entries(pg.aparelhos)) { r.aparelhos.add(ap); todos.set(ap, tipo); }
            }
        }
        return {
            dias: qtdDias,
            aparelhos: todos.size,
            noApp: [...todos.values()].filter(t => t === "app").length,
            paginas: Object.entries(paginas)
                .map(([pagina, r]) => ({ pagina, aberturas: r.aberturas, aparelhos: r.aparelhos.size }))
                .sort((a, b) => b.aberturas - a.aberturas)
        };
    };
    const porDia = Object.entries(uso.dias).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14)
        .map(([dia, doDia]) => {
            const aps = new Set();
            let aberturas = 0;
            for (const pg of Object.values(doDia)) { aberturas += pg.aberturas; Object.keys(pg.aparelhos).forEach(a => aps.add(a)); }
            return { dia, aberturas, aparelhos: aps.size };
        });
    res.json({
        semana: resumir(7),
        mes: resumir(30),
        porDia,
        avisos: {
            celulares: pushSubscriptions.length,
            comContas: pushSubscriptions.filter(s => Array.isArray(s.tags) && s.tags.length).length
        }
    });
});

// Só confere a senha admin — não altera nada
app.get("/admin/verificar", autenticarAdmin, (req, res) => {
    res.json({ ok: true });
});

// ============================================================
// ROTA 1: FRONT-END CARREGAR OS DADOS DO BANCO
// ============================================================
app.get("/membros", async (request, response) => {
    try {
        const lista = await prisma.membro.findMany({
            orderBy: { totalEstrelas: "desc" }
        });
        return response.status(200).json(lista);
    } catch (error) {
        console.error("Erro ao ler banco de dados:", error.message);
        return response.status(500).json({ erro: "Falha ao ler dados do banco." });
    }
});

app.get("/guerra-atual", async (request, response) => {
    try {
        const apiResponse = await axios.get(`${api_base}/clans/${clan_tag}/currentwar`, {
            headers: {
                'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Durante a Liga a Supercell responde "notInWar" aqui — nesse caso
        // devolvemos a guerra da Liga, no mesmo formato da guerra normal.
        if (apiResponse.data?.state === "notInWar") {
            const guerraDaLiga = await liga.buscarGuerraAtualDaLiga("principal");
            if (guerraDaLiga) return response.status(200).json(guerraDaLiga);
        }

        return response.status(200).json(apiResponse.data);
    } catch (error) {
        return response.status(500).json({ erro: "Falha ao buscar guerra atual." });
    }
});

// ============================================================
// ROTA: MEMBROS DO CLÃ (direto da Supercell)
// ============================================================
app.get("/membros-cla", async (request, response) => {
    try {
        const apiResponse = await axios.get(`${api_base}/clans/${clan_tag}/members`, {
            headers: {
                'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const membros = apiResponse.data.items.map(m => ({
            tag: m.tag,
            nome: m.name,
            cv: m.townHallLevel,
            // Extras usados pela página de Membros
            cargo: m.role,                 // leader | coLeader | admin | member
            nivel: m.expLevel,
            trofeus: m.trophies,
            doacoes: m.donations,
            doacoesRecebidas: m.donationsReceived
        }));

        return response.status(200).json(membros);
    } catch (error) {
        return response.status(500).json({ erro: "Falha ao buscar membros do clã." });
    }
});

// ============================================================
// ROTA: MEMBROS DA FAMÍLIA (os 3 clãs + o parceiro, separados por clã)
// ============================================================
// Cache curto: a galera troca de clã o tempo todo, mas não precisa bater na
// Supercell a cada visita.
let cacheFamilia = { em: 0, dados: null };
const CACHE_FAMILIA_MS = 2 * 60 * 1000;

// ============================================================
// RESUMO DOS CLÃS (cartões "Nossos Clãs" da Home)
// Nível, liga de guerra, sequência de vitórias e recorde de guerras,
// direto da API — antes eram textos fixos que ficavam desatualizados.
// 4 chamadas no máximo 1 vez por hora; se a API falhar, usa o último resumo.
// ============================================================
const CACHE_CLAS_MS = 60 * 60 * 1000;
let cacheClas = { em: 0, dados: null, buscando: null };

const LIGAS_PT = {
    "Champion League": "Campeão", "Master League": "Mestre", "Crystal League": "Cristal",
    "Gold League": "Ouro", "Silver League": "Prata", "Bronze League": "Bronze"
};
function traduzirLigaGuerra(nome) {
    if (!nome || nome === "Unranked") return null;
    const m = nome.match(/^(.+ League)\s*(I{1,3})?$/);
    return m && LIGAS_PT[m[1]] ? `${LIGAS_PT[m[1]]}${m[2] ? " " + m[2].length : ""}` : nome;
}
const FREQUENCIA_PT = { always: "Sempre", moreThanOncePerWeek: "Mais de 1x por semana", oncePerWeek: "1x por semana", lessThanOncePerWeek: "Menos de 1x por semana", never: "Nunca", unknown: null };

async function buscarResumoClas() {
    const headers = { 'Authorization': `Bearer ${process.env.CLASH_API_KEY}`, 'Accept': 'application/json' };
    const clasDaPagina = { ...liga.CLAS_LIGA, parceiro: "#2CYRC8VQL" };
    const antigos = cacheClas.dados?.clas || [];
    const clas = await Promise.all(Object.entries(clasDaPagina).map(async ([chave, tag]) => {
        try {
            const r = await axios.get(`${api_base}/clans/${encodeURIComponent(tag)}`, { headers });
            const c = r.data;
            return {
                chave,
                tag: c.tag,
                nome: c.name,
                nivel: c.clanLevel,
                // Emblema muda sozinho no jogo conforme o nível do clã
                escudo: c.badgeUrls?.large || c.badgeUrls?.medium || c.badgeUrls?.small || null,
                membros: c.members ?? (c.memberList || []).length,
                cvMinimo: c.requiredTownhallLevel || null,
                ligaGuerra: traduzirLigaGuerra(c.warLeague?.name),
                frequencia: FREQUENCIA_PT[c.warFrequency] ?? null,
                guerraPublica: !!c.isWarLogPublic,
                sequencia: c.isWarLogPublic ? (c.warWinStreak ?? 0) : null,
                vitorias: c.warWins ?? null,
                empates: c.isWarLogPublic ? (c.warTies ?? null) : null,
                derrotas: c.isWarLogPublic ? (c.warLosses ?? null) : null,
                entrada: c.type || null      // open | inviteOnly | closed
            };
        } catch (err) {
            console.error(`[Clãs] Falha ao buscar ${chave}:`, err.response?.status || err.message);
            return antigos.find(x => x.chave === chave) || { chave, tag, erro: true };
        }
    }));
    return { clas, atualizadoEm: new Date().toISOString() };
}

app.get("/clas/resumo", async (request, response) => {
    try {
        if (!cacheClas.dados || Date.now() - cacheClas.em > CACHE_CLAS_MS) {
            if (!cacheClas.buscando) {
                cacheClas.buscando = buscarResumoClas()
                    .then(dados => { cacheClas.dados = dados; cacheClas.em = Date.now(); })
                    .finally(() => { cacheClas.buscando = null; });
            }
            await cacheClas.buscando;
        }
        return response.status(200).json(cacheClas.dados);
    } catch (err) {
        console.error("[Clãs] Resumo:", err.message);
        if (cacheClas.dados) return response.status(200).json(cacheClas.dados);
        return response.status(500).json({ erro: "Falha ao buscar os clãs." });
    }
});

app.get("/membros-familia", async (request, response) => {
    if (cacheFamilia.dados && Date.now() - cacheFamilia.em < CACHE_FAMILIA_MS) {
        return response.status(200).json(cacheFamilia.dados);
    }

    const headers = {
        'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
        'Accept': 'application/json'
    };

    // O parceiro entra só aqui: não participa da Liga nem do ranking do site
    const clasDaPagina = { ...liga.CLAS_LIGA, parceiro: "#2CYRC8VQL" };

    const clas = await Promise.all(Object.entries(clasDaPagina).map(async ([chave, tag]) => {
        try {
            const r = await axios.get(`${api_base}/clans/${encodeURIComponent(tag)}`, { headers });
            const c = r.data;
            return {
                chave,
                tag: c.tag,
                nome: c.name,
                nivel: c.clanLevel,
                escudo: c.badgeUrls?.small || null,
                membros: (c.memberList || []).map(m => ({
                    tag: m.tag,
                    nome: m.name,
                    cv: m.townHallLevel,
                    cargo: m.role,
                    nivel: m.expLevel,
                    trofeus: m.trophies,
                    doacoes: m.donations,
                    doacoesRecebidas: m.donationsReceived
                }))
            };
        } catch (err) {
            console.error(`[Família] Falha ao buscar ${chave}:`, err.response?.status || err.message);
            return { chave, tag, nome: null, erro: true, membros: [] };
        }
    }));

    // Se nenhum clã respondeu, é falha geral — não guarda no cache
    if (clas.every(c => c.erro)) {
        return response.status(500).json({ erro: "Falha ao buscar os clãs da família." });
    }

    const dados = { clas };
    if (clas.every(c => !c.erro)) cacheFamilia = { em: Date.now(), dados };
    return response.status(200).json(dados);
});

// ============================================================
// ROTA: ÚLTIMAS GUERRAS DE UM JOGADOR (perfil)
// Guerras registradas em detalhe vêm completas (ataques + defesa).
// Guerras antigas, de antes do detalhe, saem dos ataques gravados no
// banco: estrelas e % de cada ataque; adversário/resultado vêm do
// registro de guerra do clã, quando dá pra casar a data.
// ============================================================
async function obterWarlogPrincipal() {
    const emCache = cacheGuerras.principal;
    if (emCache && Date.now() - emCache.em < CACHE_GUERRAS_MS) return emCache.dados.guerras || [];
    if (cacheWarlogPerfil && Date.now() - cacheWarlogPerfil.em < CACHE_GUERRAS_MS) return cacheWarlogPerfil.guerras;
    try {
        const r = await axios.get(`${api_base}/clans/${clan_tag}/warlog?limit=30`, {
            headers: { 'Authorization': `Bearer ${process.env.CLASH_API_KEY}`, 'Accept': 'application/json' }
        });
        const RESULTADO = { win: "vitoria", lose: "derrota", tie: "empate" };
        const guerras = (r.data?.items || [])
            .filter(g => g.opponent?.tag && RESULTADO[g.result])
            .map(g => ({
                resultado: RESULTADO[g.result],
                fim: g.endTime,
                nos: { estrelas: g.clan?.stars ?? 0, destruicao: g.clan?.destructionPercentage ?? 0 },
                adversario: {
                    tag: g.opponent.tag, nome: g.opponent.name, escudo: g.opponent.badgeUrls?.small || null,
                    estrelas: g.opponent.stars ?? 0, destruicao: g.opponent.destructionPercentage ?? 0
                }
            }));
        cacheWarlogPerfil = { em: Date.now(), guerras };
        return guerras;
    } catch (err) {
        return [];   // registro privado ou API fora: as guerras antigas saem sem adversário
    }
}
let cacheWarlogPerfil = null;

app.get("/jogador/:tag/guerras", async (request, response) => {
    let tag = String(request.params.tag || "").trim().toUpperCase();
    if (!tag.startsWith("#")) tag = `#${tag}`;
    if (!/^#[0-9A-Z]{3,15}$/.test(tag)) return response.status(400).json({ erro: "Tag inválida." });
    const limite = Math.min(Math.max(parseInt(request.query.limite, 10) || 10, 1), 30);

    try {
        const guerras = [];

        // 1) Guerras com detalhe completo
        for (const g of Object.values(guerrasDetalhe)) {
            const m = g.membros?.[tag];
            if (!m) continue;
            guerras.push({
                warId: g.warId, inicio: g.inicio, fim: g.fim, completa: true,
                resultado: g.resultado, placar: g.placar, adversario: g.adversario,
                tamanho: g.tamanho, ataquesPermitidos: g.ataquesPorMembro,
                cv: m.cv, posicao: m.posicao, ataques: m.ataques, defesa: m.defesa
            });
        }

        // 2) Guerras antigas: só os ataques gravados no banco
        const conhecidas = new Set(guerras.map(g => g.warId));
        const registros = await prisma.ataqueRegistrado.findMany({
            where: { tagJogador: tag },
            orderBy: { createdAt: "desc" },
            take: 120
        });
        const porGuerra = new Map();
        for (const a of registros) {
            if (conhecidas.has(a.warId)) continue;
            if (!porGuerra.has(a.warId)) porGuerra.set(a.warId, []);
            porGuerra.get(a.warId).push(a);
        }

        if (porGuerra.size) {
            const warlog = await obterWarlogPrincipal();
            const DIA = 24 * 60 * 60 * 1000;
            for (const [warId, ataques] of porGuerra) {
                const inicio = liga.parseDataCoC(warId);
                let par = null;
                if (inicio && !isNaN(inicio)) {
                    let menor = Infinity;
                    for (const w of warlog) {
                        const fim = liga.parseDataCoC(w.fim);
                        const dif = fim - inicio;
                        if (dif > 0 && dif < 4 * DIA && dif < menor) { menor = dif; par = w; }
                    }
                }
                const ordem = id => parseInt(String(id).split("_").pop(), 10) || 0;
                guerras.push({
                    warId, inicio: warId, fim: par?.fim || null, completa: false,
                    emAndamento: !par && inicio && !isNaN(inicio) && (Date.now() - inicio) < 3 * DIA,
                    resultado: par?.resultado || null,
                    placar: par ? {
                        nos: par.nos,
                        eles: { estrelas: par.adversario.estrelas, destruicao: par.adversario.destruicao }
                    } : null,
                    adversario: par ? { tag: par.adversario.tag, nome: par.adversario.nome, escudo: par.adversario.escudo } : null,
                    ataques: ataques
                        .sort((a, b) => ordem(a.idAtaque) - ordem(b.idAtaque))
                        .map(a => ({ estrelas: a.estrelas, destruicao: a.destruicao, cvAlvo: null, posicaoAlvo: null })),
                    defesa: null
                });
            }
        }

        guerras.sort((a, b) => String(b.inicio || b.warId).localeCompare(String(a.inicio || a.warId)));
        const lista = guerras.slice(0, limite);

        // Resumo das guerras mostradas
        const terminadas = lista.filter(g => !g.emAndamento);
        const ataques = terminadas.flatMap(g => g.ataques);
        const completas = terminadas.filter(g => g.completa);
        const perdidos = completas.reduce((n, g) => n + Math.max(0, (g.ataquesPermitidos || 2) - g.ataques.length), 0);
        const defesas = completas.map(g => g.defesa).filter(d => d?.atacada && !d.parcial);
        const resumo = {
            guerras: terminadas.length,
            ataques: ataques.length,
            mediaEstrelas: ataques.length ? +(ataques.reduce((n, a) => n + a.estrelas, 0) / ataques.length).toFixed(2) : null,
            mediaDestruicao: ataques.length ? +(ataques.reduce((n, a) => n + a.destruicao, 0) / ataques.length).toFixed(1) : null,
            triplas: ataques.filter(a => a.estrelas === 3).length,
            ataquesPerdidos: perdidos,
            guerrasComDetalhe: completas.length,
            defesasSeguradas: defesas.reduce((n, d) => n + (d.seguradas || 0), 0),
            freshTomados: defesas.filter(d => d.fresh).length
        };

        return response.status(200).json({ tag, resumo, guerras: lista });
    } catch (err) {
        console.error("[Guerras do jogador]", err.message);
        return response.status(500).json({ erro: "Falha ao montar o histórico de guerras." });
    }
});

// ============================================================
// ROTA: DEFESAS DO MÊS ("Muralha do Mês")
// ============================================================
function rankingDefesas(mes) {
    const doMes = defesas[mes];
    return Object.entries(doMes?.jogadores || {})
        .map(([tag, j]) => {
            const seguradas = j.seguradas || 0;
            return {
                tag, ...j,
                seguradas,
                ataquesSofridos: j.defesas,
                caidas: j.defesas - seguradas,
                mediaEstrelas: seguradas ? +(j.estrelasSeguradas / seguradas).toFixed(2) : null,
                mediaDestruicao: seguradas ? +(j.destruicaoSegurada / seguradas).toFixed(1) : null
            };
        })
        .filter(j => j.seguradas > 0)
        .sort((a, b) => b.seguradas - a.seguradas
            || b.defesasPerfeitas - a.defesasPerfeitas
            || a.mediaEstrelas - b.mediaEstrelas
            || a.mediaDestruicao - b.mediaDestruicao);
}

function mesAtualTexto() {
    const hoje = new Date();
    return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================
// ROTA: MEU PAINEL — tudo de uma conta numa chamada só
// (posição no ranking do mês, guerra atual, sequência de 3★, defesas)
// ============================================================
let cacheGuerraPainel = { em: 0, dados: null };

async function obterGuerraAtualPainel() {
    if (cacheGuerraPainel.dados && Date.now() - cacheGuerraPainel.em < 2 * 60 * 1000) return cacheGuerraPainel.dados;
    let dados = null;
    try {
        const r = await axios.get(`${api_base}/clans/${clan_tag}/currentwar`, {
            headers: { 'Authorization': `Bearer ${process.env.CLASH_API_KEY}`, 'Accept': 'application/json' }
        });
        dados = r.data;
        if (dados?.state === "notInWar") {
            const daLiga = await liga.buscarGuerraAtualDaLiga("principal").catch(() => null);
            dados = daLiga ? { ...daLiga, ehLiga: true } : dados;
        }
    } catch (err) {
        dados = null;
    }
    cacheGuerraPainel = { em: Date.now(), dados };
    return dados;
}

app.get("/painel/:tag", async (request, response) => {
    let tag = String(request.params.tag || "").trim().toUpperCase();
    if (!tag.startsWith("#")) tag = `#${tag}`;
    if (!/^#[0-9A-Z]{3,15}$/.test(tag)) return response.status(400).json({ erro: "Tag inválida." });

    try {
        const [membros, registros, guerra] = await Promise.all([
            prisma.membro.findMany(),
            prisma.ataqueRegistrado.findMany({ where: { tagJogador: tag }, orderBy: { createdAt: "desc" }, take: 60 }),
            obterGuerraAtualPainel()
        ]);

        // Ranking do mês: mesmo critério do site (guerras, média ★, média %, CV)
        const ranking = ordenarRanking(membros);
        const eu = ranking.find(m => m.tag === tag);
        const mes = eu ? {
            posicao: eu.posicao,
            total: ranking.length,
            guerras: eu.guerras,
            mediaEstrelas: eu.guerras ? +(eu.totalEstrelas / eu.guerras).toFixed(2) : 0,
            mediaDestruicao: eu.guerras ? +(eu.totalDestruicao / eu.guerras / 2).toFixed(1) : 0
        } : null;

        // Sequência de 3★
        let atual = 0;
        while (atual < registros.length && registros[atual].estrelas === 3) atual++;
        let melhor = 0, corrida = 0;
        for (const a of [...registros].reverse()) {
            corrida = a.estrelas === 3 ? corrida + 1 : 0;
            melhor = Math.max(melhor, corrida);
        }

        // Guerra atual
        let guerraAtual = null;
        if (guerra && guerra.state && guerra.state !== "notInWar") {
            const m = (guerra.clan?.members || []).find(x => x.tag === tag);
            const permitidos = guerra.attacksPerMember || (guerra.ehLiga ? 1 : 2);
            guerraAtual = {
                estado: guerra.state,
                liga: !!guerra.ehLiga,
                adversario: guerra.opponent?.name || null,
                inicio: guerra.startTime || null,
                fim: guerra.endTime || null,
                placar: {
                    nos: guerra.clan?.stars ?? 0,
                    eles: guerra.opponent?.stars ?? 0
                },
                participa: !!m,
                posicao: m?.mapPosition ?? null,
                ataquesPermitidos: permitidos,
                ataques: (m?.attacks || []).map(a => ({ estrelas: a.stars || 0, destruicao: a.destructionPercentage || 0 }))
            };
        }

        // Defesas do mês (Muralha)
        const defs = rankingDefesas(mesAtualTexto());
        const iDef = defs.findIndex(d => d.tag === tag);
        const defesasMes = iDef >= 0
            ? { seguradas: defs[iDef].seguradas, ataquesSofridos: defs[iDef].ataquesSofridos, posicao: iDef + 1, muralha: iDef === 0 }
            : null;

        // Novidades do clã (tudo já está na memória: não chama a API)
        const ultima = Object.values(guerrasDetalhe)
            .filter(g => g.fim)
            .sort((a, b) => String(b.fim).localeCompare(String(a.fim)))[0];
        const cla = {
            ultimaGuerra: ultima ? {
                adversario: ultima.adversario?.nome || null,
                resultado: ultima.resultado || null,
                fim: ultima.fim,
                placar: { nos: ultima.placar?.nos?.estrelas ?? 0, eles: ultima.placar?.eles?.estrelas ?? 0 }
            } : null,
            liderMes: ranking[0] ? { tag: ranking[0].tag, nome: ranking[0].nome, guerras: ranking[0].guerras } : null,
            muralha: defs[0] ? { tag: defs[0].tag, nome: defs[0].nome || null, seguradas: defs[0].seguradas } : null
        };

        return response.status(200).json({
            tag,
            nome: eu?.nome || guerra?.clan?.members?.find(x => x.tag === tag)?.name || null,
            cv: eu?.cv ?? null,
            mes,
            sequencia: { atual, melhor },
            guerraAtual,
            defesasMes,
            cla
        });
    } catch (err) {
        console.error("[Meu Painel]", err.message);
        return response.status(500).json({ erro: "Falha ao montar o painel." });
    }
});

// ============================================================
// EVOLUÇÃO DA CONTA: uma foto por dia de cada membro da família
// (CV, heróis, equipamentos, troféus). Comparando as fotos dá pra
// mostrar as melhorias no perfil. Arquivo próprio, sem mexer no banco.
// ============================================================
const ARQUIVO_EVOLUCAO = path.join(__dirname, "evolucao.json");

function carregarEvolucao() {
    try {
        const d = JSON.parse(fs.readFileSync(ARQUIVO_EVOLUCAO, "utf8"));
        if (d && typeof d === "object" && d.jogadores) return d;
    } catch (err) { }
    return { _ultimoDia: null, jogadores: {} };
}
let evolucao = carregarEvolucao();

function salvarEvolucao() {
    try {
        const tmp = `${ARQUIVO_EVOLUCAO}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(evolucao));
        fs.renameSync(tmp, ARQUIVO_EVOLUCAO);
    } catch (err) {
        console.error("[Evolução] Não foi possível salvar:", err.message);
    }
}

function hojeBR() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });   // AAAA-MM-DD
}

let evolucaoRodando = false;
async function registrarEvolucaoDiaria() {
    const hoje = hojeBR();
    if (evolucao._ultimoDia === hoje || evolucaoRodando) return;
    evolucaoRodando = true;
    try {
        const headers = { 'Authorization': `Bearer ${process.env.CLASH_API_KEY}`, 'Accept': 'application/json' };
        const tags = new Set();
        // Só os 3 clãs da família (o parceiro não entra na evolução nem no Construtor do Mês)
        for (const [chaveCla, tagCla] of Object.entries(liga.CLAS_LIGA)) {
            if (chaveCla === "parceiro") continue;
            try {
                const r = await axios.get(`${api_base}/clans/${encodeURIComponent(tagCla)}/members`, { headers });
                for (const m of r.data?.items || []) tags.add(m.tag);
            } catch (err) {
                console.error("[Evolução] Falha ao listar membros:", err.response?.status || err.message);
            }
        }
        if (!tags.size) return;   // API fora: tenta de novo na próxima

        let fotos = 0;
        for (const tag of tags) {
            try {
                const p = (await axios.get(`${api_base}/players/${encodeURIComponent(tag)}`, { headers })).data;
                const herois = {};
                for (const h of p.heroes || []) if (h.village === "home") herois[h.name] = h.level;
                const equipamentos = {};
                for (const e of p.heroEquipment || []) if (e.village === "home") equipamentos[e.name] = e.level;
                const foto = {
                    data: hoje, cv: p.townHallLevel, armaCv: p.townHallWeaponLevel ?? null,
                    herois, equipamentos, trofeus: p.trophies, nivel: p.expLevel
                };
                const reg = evolucao.jogadores[tag] || (evolucao.jogadores[tag] = { nome: p.name, fotos: [] });
                reg.nome = p.name;
                const ultima = reg.fotos[reg.fotos.length - 1];
                if (ultima?.data === hoje) reg.fotos[reg.fotos.length - 1] = foto;
                else reg.fotos.push(foto);
                if (reg.fotos.length > 400) reg.fotos.splice(0, reg.fotos.length - 400);
                fotos++;
            } catch (err) { /* um jogador com erro não para os outros */ }
            await new Promise(r => setTimeout(r, 120));   // sem pressa com a API
        }
        evolucao._ultimoDia = hoje;
        salvarEvolucao();
        cacheConstrutores = null;
        console.log(`[Evolução] Foto do dia ${hoje}: ${fotos} jogador(es).`);
    } finally {
        evolucaoRodando = false;
    }
}

const somaNiveis = obj => Object.values(obj || {}).reduce((n, v) => n + (v || 0), 0);

// Compara duas fotos seguidas e lista o que subiu
function melhoriasEntre(antes, depois) {
    const lista = [];
    if (depois.cv > antes.cv) lista.push({ data: depois.data, tipo: "cv", nome: "Centro de Vila", de: antes.cv, para: depois.cv });
    else if (depois.armaCv && depois.armaCv > (antes.armaCv || 0) && depois.cv === antes.cv)
        lista.push({ data: depois.data, tipo: "arma", nome: "Arma do CV", de: antes.armaCv || 0, para: depois.armaCv });
    for (const [nome, nivel] of Object.entries(depois.herois || {})) {
        const ant = antes.herois?.[nome] || 0;
        if (nivel > ant) lista.push({ data: depois.data, tipo: "heroi", nome, de: ant, para: nivel });
    }
    for (const [nome, nivel] of Object.entries(depois.equipamentos || {})) {
        const ant = antes.equipamentos?.[nome] || 0;
        if (nivel > ant) lista.push({ data: depois.data, tipo: "equip", nome, de: ant, para: nivel });
    }
    return lista;
}

// Quem mais subiu heróis + equipamentos em cada mês já encerrado
let cacheConstrutores = null;
function construtoresPorMes() {
    if (cacheConstrutores) return cacheConstrutores;
    const mesAtual = hojeBR().slice(0, 7);
    const ganhos = {};   // mes -> { tag: niveis }
    for (const [tag, reg] of Object.entries(evolucao.jogadores)) {
        const fotos = reg.fotos;
        for (let i = 1; i < fotos.length; i++) {
            const mes = fotos[i].data.slice(0, 7);
            if (mes >= mesAtual) continue;
            const g = (somaNiveis(fotos[i].herois) + somaNiveis(fotos[i].equipamentos))
                    - (somaNiveis(fotos[i - 1].herois) + somaNiveis(fotos[i - 1].equipamentos));
            if (g <= 0) continue;
            (ganhos[mes] || (ganhos[mes] = {}))[tag] = (ganhos[mes][tag] || 0) + g;
        }
    }
    const vencedores = {};   // mes -> tag
    for (const [mes, porTag] of Object.entries(ganhos)) {
        const top = Object.entries(porTag).sort((a, b) => b[1] - a[1])[0];
        if (top) vencedores[mes] = top[0];
    }
    cacheConstrutores = vencedores;
    return vencedores;
}

app.get("/jogador/:tag/evolucao", (request, response) => {
    let tag = String(request.params.tag || "").trim().toUpperCase();
    if (!tag.startsWith("#")) tag = `#${tag}`;
    const reg = evolucao.jogadores[tag];
    if (!reg || !reg.fotos.length) return response.status(200).json({ tag, acompanhandoDesde: null, serie: [], melhorias: [] });

    const fotos = reg.fotos;
    const melhorias = [];
    for (let i = 1; i < fotos.length; i++) melhorias.push(...melhoriasEntre(fotos[i - 1], fotos[i]));
    melhorias.reverse();

    const limite30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const ultimos30 = melhorias.filter(m => m.data >= limite30);
    const ganho = tipo => ultimos30.filter(m => m.tipo === tipo).reduce((n, m) => n + (m.para - m.de), 0);

    const construtor = Object.entries(construtoresPorMes()).filter(([, t]) => t === tag).map(([mes]) => mes);

    return response.status(200).json({
        tag,
        acompanhandoDesde: fotos[0].data,
        serie: fotos.map(f => ({ data: f.data, herois: somaNiveis(f.herois), equipamentos: somaNiveis(f.equipamentos), cv: f.cv })),
        melhorias: melhorias.slice(0, 60),
        ultimos30Dias: { herois: ganho("heroi"), equipamentos: ganho("equip"), cv: ultimos30.some(m => m.tipo === "cv") },
        construtorDoMes: construtor
    });
});

// ============================================================
// ROTA: CONQUISTAS DO JOGADOR (perfil)
// Tudo calculado com o que já está guardado: ataques no banco,
// temporadas fechadas, defesas por mês e guerras em detalhe.
// ============================================================
const NIVEIS = ["Bronze", "Prata", "Ouro", "Diamante"];

function conquistaPorNivel(base, valor, metas) {
    let nivel = -1;
    metas.forEach((m, i) => { if (valor >= m) nivel = i; });
    const proxima = metas[nivel + 1];
    return {
        ...base,
        conquistada: nivel >= 0,
        nivel: nivel >= 0 ? NIVEIS[nivel] : null,
        valor,
        progresso: proxima ? { atual: valor, meta: proxima } : null
    };
}

app.get("/jogador/:tag/conquistas", async (request, response) => {
    let tag = String(request.params.tag || "").trim().toUpperCase();
    if (!tag.startsWith("#")) tag = `#${tag}`;
    if (!/^#[0-9A-Z]{3,15}$/.test(tag)) return response.status(400).json({ erro: "Tag inválida." });

    try {
        const mesAtual = mesAtualTexto();
        const [ataques, temporadas, membro] = await Promise.all([
            prisma.ataqueRegistrado.findMany({ where: { tagJogador: tag }, orderBy: { createdAt: "asc" }, take: 2000 }),
            prisma.temporada.findMany(),
            prisma.membro.findUnique({ where: { tag } })
        ]);

        // ---- ataques: triplas, melhor sequência, guerras perfeitas ----
        const triplas = ataques.filter(a => a.estrelas === 3).length;
        let melhorSeq = 0, corrida = 0;
        for (const a of ataques) { corrida = a.estrelas === 3 ? corrida + 1 : 0; melhorSeq = Math.max(melhorSeq, corrida); }
        const porGuerra = new Map();
        for (const a of ataques) {
            if (!porGuerra.has(a.warId)) porGuerra.set(a.warId, []);
            porGuerra.get(a.warId).push(a);
        }
        let guerrasPerfeitas = 0;
        for (const [warId, lista] of porGuerra) {
            const permitidos = guerrasDetalhe[warId]?.ataquesPorMembro || 2;
            if (lista.length >= permitidos && lista.every(a => a.estrelas === 3)) guerrasPerfeitas++;
        }

        // ---- temporadas fechadas: MVP e pódio ----
        const nomeAtual = membro?.nome || null;
        let mvp = 0, podio = 0;
        for (const t of temporadas) {
            const snap = Array.isArray(t.snapshot) ? t.snapshot : [];
            const eu = snap.find(j => (j.tag && String(j.tag).toUpperCase() === tag) || (!j.tag && nomeAtual && j.nome === nomeAtual));
            if (!eu) continue;
            const pos = eu.posicao || (snap.indexOf(eu) + 1);
            if (pos === 1) mvp++;
            if (pos <= 3) podio++;
        }

        // ---- Muralha do Mês (só meses já encerrados) ----
        let muralhas = 0;
        for (const mes of Object.keys(defesas)) {
            if (mes >= mesAtual) continue;
            if (rankingDefesas(mes)[0]?.tag === tag) muralhas++;
        }

        // ---- guerras em detalhe: paredão e mês sem falhar ----
        let paredao = 0;
        const porMes = new Map();
        for (const g of Object.values(guerrasDetalhe)) {
            const m = g.membros?.[tag];
            if (!m) continue;
            if ((m.defesa?.seguradas || 0) >= 3) paredao++;
            const mes = `${String(g.warId).slice(0, 4)}-${String(g.warId).slice(4, 6)}`;
            if (!porMes.has(mes)) porMes.set(mes, { guerras: 0, falhou: false });
            const r = porMes.get(mes);
            r.guerras++;
            if (m.ataques.length < (g.ataquesPorMembro || 2)) r.falhou = true;
        }
        let mesesSemFalhar = 0;
        for (const [mes, r] of porMes) if (mes < mesAtual && r.guerras >= 3 && !r.falhou) mesesSemFalhar++;

        const vezes = (base, n) => ({ ...base, conquistada: n > 0, vezes: n, progresso: null });
        const conquistas = [
            vezes({ id: "mvp", icone: "👑", nome: "MVP do Mês", descricao: "Terminou um mês em 1º no ranking" }, mvp),
            vezes({ id: "podio", icone: "🥇", nome: "Pódio", descricao: "Terminou um mês no top 3" }, podio),
            vezes({ id: "muralha", icone: "🛡️", nome: "Muralha do Mês", descricao: "Mais defesas seguradas num mês" }, muralhas),
            conquistaPorNivel({ id: "sequencia", icone: "🔥", nome: "Sequência de 3★", descricao: "Ataques seguidos com 3 estrelas" }, melhorSeq, [5, 10, 20, 40]),
            conquistaPorNivel({ id: "triplas", icone: "⭐", nome: "Colecionador de 3★", descricao: "Total de ataques com 3 estrelas" }, triplas, [25, 50, 100, 250]),
            vezes({ id: "perfeita", icone: "🎯", nome: "Guerra Perfeita", descricao: "Todos os ataques de uma guerra com 3★" }, guerrasPerfeitas),
            vezes({ id: "paredao", icone: "🧱", nome: "Paredão", descricao: "Segurou 3 ou mais ataques numa guerra" }, paredao),
            vezes({ id: "semfalta", icone: "✅", nome: "Mês sem falhar", descricao: "Mês com 3+ guerras sem perder ataque" }, mesesSemFalhar),
            vezes({ id: "construtor", icone: "🔨", nome: "Construtor do Mês", descricao: "Quem mais subiu heróis e equipamentos num mês" },
                Object.values(construtoresPorMes()).filter(t => t === tag).length)
        ];

        return response.status(200).json({
            tag,
            conquistadas: conquistas.filter(c => c.conquistada).length,
            total: conquistas.length,
            conquistas
        });
    } catch (err) {
        console.error("[Conquistas]", err.message);
        return response.status(500).json({ erro: "Falha ao calcular as conquistas." });
    }
});

app.get("/defesas", (request, response) => {
    const hoje = new Date();
    const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const mes = /^\d{4}-\d{2}$/.test(request.query.mes || "") ? request.query.mes : mesAtual;
    const doMes = defesas[mes];

    // Só contam as defesas que seguraram (0, 1 ou 2 estrelas). Base que tomou 3 caiu.
    const ranking = Object.entries(doMes?.jogadores || {})
        .map(([tag, j]) => {
            const seguradas = j.seguradas || 0;
            return {
                tag, ...j,
                seguradas,
                ataquesSofridos: j.defesas,
                caidas: j.defesas - seguradas,
                mediaEstrelas: seguradas ? +(j.estrelasSeguradas / seguradas).toFixed(2) : null,
                mediaDestruicao: seguradas ? +(j.destruicaoSegurada / seguradas).toFixed(1) : null
            };
        })
        .filter(j => j.seguradas > 0)
        // Mais defesas seguradas; empate: mais sem tomar estrela, menos estrelas, menos destruição
        .sort((a, b) => b.seguradas - a.seguradas
            || b.defesasPerfeitas - a.defesasPerfeitas
            || a.mediaEstrelas - b.mediaEstrelas
            || a.mediaDestruicao - b.mediaDestruicao);

    const minimoDefesas = 1;
    const muralha = ranking[0] || null;

    return response.status(200).json({
        mes,
        guerras: doMes?.guerras?.length || 0,
        minimoDefesas,
        muralha,
        ranking
    });
});

// ============================================================
// ROTA: CAPITAL DO CLÃ (ataques de fim de semana)
// ============================================================
const cacheCapital = {};
const CACHE_CAPITAL_MS = 10 * 60 * 1000;

app.get("/capital/:cla", async (request, response) => {
    const chave = request.params.cla;
    const tag = liga.CLAS_LIGA[chave];
    if (!tag) return response.status(400).json({ erro: "Clã inválido. Use principal, cla2 ou cla3." });

    const emCache = cacheCapital[chave];
    if (emCache && Date.now() - emCache.em < CACHE_CAPITAL_MS) {
        return response.status(200).json(emCache.dados);
    }

    const headers = {
        'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
        'Accept': 'application/json'
    };
    const tagUrl = encodeURIComponent(tag);

    try {
        const [rRaides, rCla] = await Promise.all([
            axios.get(`${api_base}/clans/${tagUrl}/capitalraidseasons?limit=12`, { headers }),
            axios.get(`${api_base}/clans/${tagUrl}`, { headers }).catch(() => null)
        ]);
        const c = rCla?.data || {};

        const dados = {
            cla: chave,
            tag,
            nome: c.name || null,
            escudo: c.badgeUrls?.small || null,
            salaoCapital: c.clanCapital?.capitalHallLevel ?? null,
            ligaCapital: c.capitalLeague?.name || null,
            pontosCapital: c.clanCapitalPoints ?? null,
            // Quem está no clã agora — usado para mostrar quem não atacou no fim de semana atual
            membrosAtuais: (c.memberList || []).map(m => ({ tag: m.tag, nome: m.name, cv: m.townHallLevel })),
            temporadas: (rRaides.data?.items || []).map(t => ({
                estado: t.state,                       // ongoing | ended
                inicio: t.startTime,
                fim: t.endTime,
                saqueTotal: t.capitalTotalLoot || 0,
                raidesCompletos: t.raidsCompleted || 0,
                ataques: t.totalAttacks || 0,
                distritosDestruidos: t.enemyDistrictsDestroyed || 0,
                membros: (t.members || []).map(m => ({
                    tag: m.tag,
                    nome: m.name,
                    ataques: m.attacks || 0,
                    limite: (m.attackLimit || 0) + (m.bonusAttackLimit || 0),
                    saque: m.capitalResourcesLooted || 0
                }))
            }))
        };

        cacheCapital[chave] = { em: Date.now(), dados };
        return response.status(200).json(dados);
    } catch (err) {
        console.error(`[Capital] Falha ao buscar ${chave}:`, err.response?.status || err.message);
        return response.status(500).json({ erro: "Falha ao buscar os dados da Capital." });
    }
});

// ============================================================
// ROTA: HISTÓRICO DE GUERRAS DO CLÃ (registro de guerra da Supercell)
// ============================================================
const cacheGuerras = {};
const CACHE_GUERRAS_MS = 10 * 60 * 1000;

app.get("/guerras/:cla", async (request, response) => {
    const chave = request.params.cla;
    const tag = liga.CLAS_LIGA[chave];
    if (!tag) return response.status(400).json({ erro: "Clã inválido. Use principal, cla2 ou cla3." });

    const emCache = cacheGuerras[chave];
    if (emCache && Date.now() - emCache.em < CACHE_GUERRAS_MS) {
        return response.status(200).json(emCache.dados);
    }

    const headers = {
        'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
        'Accept': 'application/json'
    };
    const tagUrl = encodeURIComponent(tag);

    try {
        const rCla = await axios.get(`${api_base}/clans/${tagUrl}`, { headers });
        const c = rCla.data || {};

        // Registro de guerra privado no jogo = a Supercell responde 403 aqui
        let itens = [];
        let logPublico = c.isWarLogPublic !== false;
        if (logPublico) {
            try {
                const rLog = await axios.get(`${api_base}/clans/${tagUrl}/warlog?limit=30`, { headers });
                itens = rLog.data?.items || [];
            } catch (err) {
                if (err.response?.status === 403) logPublico = false;
                else throw err;
            }
        }

        const RESULTADO = { win: "vitoria", lose: "derrota", tie: "empate" };

        const dados = {
            cla: chave,
            tag,
            nome: c.name || null,
            escudo: c.badgeUrls?.small || null,
            vitorias: c.warWins ?? null,
            derrotas: c.warLosses ?? null,
            empates: c.warTies ?? null,
            sequencia: c.warWinStreak ?? null,
            logPublico,
            guerras: itens
                // Rodadas de Liga entram no registro sem adversário e sem resultado — ficam de fora
                .filter(g => g.opponent?.tag && RESULTADO[g.result])
                .map(g => ({
                    resultado: RESULTADO[g.result],
                    fim: g.endTime,
                    tamanho: g.teamSize,
                    ataquesPorMembro: g.attacksPerMember || 2,
                    nos: {
                        estrelas: g.clan?.stars ?? 0,
                        destruicao: g.clan?.destructionPercentage ?? 0,
                        ataques: g.clan?.attacks ?? null
                    },
                    adversario: {
                        tag: g.opponent.tag,
                        nome: g.opponent.name,
                        escudo: g.opponent.badgeUrls?.small || null,
                        nivel: g.opponent.clanLevel ?? null,
                        estrelas: g.opponent.stars ?? 0,
                        destruicao: g.opponent.destructionPercentage ?? 0
                    }
                }))
        };

        cacheGuerras[chave] = { em: Date.now(), dados };
        return response.status(200).json(dados);
    } catch (err) {
        console.error(`[Guerras] Falha ao buscar ${chave}:`, err.response?.status || err.message);
        return response.status(500).json({ erro: "Falha ao buscar o histórico de guerras." });
    }
});

// ============================================================
// ATAQUES: exércitos recomendados e equipamentos meta
// ============================================================
// Conteúdo cadastrado pela liderança (não vem da Supercell). Fica num
// arquivo, igual às defesas — sem mexer no banco.
const ARQUIVO_ATAQUES = path.join(__dirname, "ataques.json");

function carregarAtaques() {
    try {
        const d = JSON.parse(fs.readFileSync(ARQUIVO_ATAQUES, "utf8"));
        return {
            atualizadoEm: d.atualizadoEm || null,
            exercitos: Array.isArray(d.exercitos) ? d.exercitos : [],
            equipamentosMeta: d.equipamentosMeta && typeof d.equipamentosMeta === "object" ? d.equipamentosMeta : {}
        };
    } catch (err) {
        return { atualizadoEm: null, exercitos: [], equipamentosMeta: {} };
    }
}

let ataques = carregarAtaques();

function salvarAtaques() {
    ataques.atualizadoEm = new Date().toISOString();
    const temporario = `${ARQUIVO_ATAQUES}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(ataques, null, 2));
    fs.renameSync(temporario, ARQUIVO_ATAQUES);
}

const DIFICULDADES = ["facil", "medio", "dificil"];
const texto = (v, max) => String(v ?? "").trim().slice(0, max);

// Valida o que veio do painel. Devolve { erro } ou { exercito }.
function validarExercito(corpo) {
    const cv = parseInt(corpo?.cv, 10);
    const nome = texto(corpo?.nome, 60);
    const link = texto(corpo?.link, 600);
    const dificuldade = DIFICULDADES.includes(corpo?.dificuldade) ? corpo.dificuldade : "medio";
    const video = texto(corpo?.video, 300);

    if (!(cv >= 1 && cv <= 30)) return { erro: "Escolha o Centro de Vila." };
    if (!nome) return { erro: "Dê um nome para o ataque." };
    // Só aceita o link oficial de "copiar exército" do jogo
    if (!/^https:\/\/link\.clashofclans\.com\/\S*action=CopyArmy\S*army=/i.test(link)) {
        return { erro: "O link precisa ser o de copiar exército do jogo (link.clashofclans.com ... action=CopyArmy)." };
    }
    // Vídeo é opcional; quando vier, só aceita YouTube ou Instagram
    if (video && !/^https:\/\/((www|m)\.)?(youtube\.com|youtu\.be|instagram\.com)\/\S+$/i.test(video)) {
        return { erro: "O vídeo precisa ser um link do YouTube ou do Instagram." };
    }
    return {
        exercito: {
            cv, nome, link, dificuldade,
            composicao: texto(corpo?.composicao, 200),
            dica: texto(corpo?.dica, 500),
            video
        }
    };
}

// Público: tudo que a página Ataques e o perfil precisam
app.get("/ataques", (request, response) => {
    return response.status(200).json(ataques);
});

app.post("/ataques/exercitos", autenticarAdmin, (request, response) => {
    const { erro, exercito } = validarExercito(request.body);
    if (erro) return response.status(400).json({ erro });
    if (ataques.exercitos.length >= 80) return response.status(400).json({ erro: "Limite de exércitos atingido." });

    const novo = { id: `ex_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...exercito, criadoEm: new Date().toISOString() };
    ataques.exercitos.push(novo);
    try { salvarAtaques(); } catch (err) { return response.status(500).json({ erro: "Não foi possível salvar." }); }
    return response.status(201).json(novo);
});

app.put("/ataques/exercitos/:id", autenticarAdmin, (request, response) => {
    const i = ataques.exercitos.findIndex(e => e.id === request.params.id);
    if (i < 0) return response.status(404).json({ erro: "Exército não encontrado." });
    const { erro, exercito } = validarExercito(request.body);
    if (erro) return response.status(400).json({ erro });

    ataques.exercitos[i] = { ...ataques.exercitos[i], ...exercito };
    try { salvarAtaques(); } catch (err) { return response.status(500).json({ erro: "Não foi possível salvar." }); }
    return response.status(200).json(ataques.exercitos[i]);
});

app.delete("/ataques/exercitos/:id", autenticarAdmin, (request, response) => {
    const antes = ataques.exercitos.length;
    ataques.exercitos = ataques.exercitos.filter(e => e.id !== request.params.id);
    if (ataques.exercitos.length === antes) return response.status(404).json({ erro: "Exército não encontrado." });
    try { salvarAtaques(); } catch (err) { return response.status(500).json({ erro: "Não foi possível salvar." }); }
    return response.status(200).json({ ok: true });
});

app.put("/ataques/equipamentos", autenticarAdmin, (request, response) => {
    const entrada = request.body?.equipamentosMeta;
    if (!entrada || typeof entrada !== "object") return response.status(400).json({ erro: "Lista inválida." });

    const limpo = {};
    for (const [heroi, lista] of Object.entries(entrada).slice(0, 12)) {
        if (!Array.isArray(lista)) continue;
        const nomes = [...new Set(lista.map(n => texto(n, 60)).filter(Boolean))].slice(0, 12);
        if (nomes.length) limpo[texto(heroi, 40)] = nomes;
    }
    ataques.equipamentosMeta = limpo;
    try { salvarAtaques(); } catch (err) { return response.status(500).json({ erro: "Não foi possível salvar." }); }
    return response.status(200).json(ataques);
});

// Catálogo de equipamentos por herói, montado a partir do que os membros
// do clã usam de verdade (a API não tem uma lista pronta). Assim, quando
// sair equipamento novo, ele aparece sozinho no painel.
let cacheCatalogo = { em: 0, dados: null };

// Equipamentos conhecidos por herói. Serve para encaixar no herói certo os
// equipamentos que os membros têm mas não estão usando no momento (a API só
// diz de qual herói é o equipamento quando ele está equipado).
const EQUIP_POR_HEROI = {
    "Barbarian King": ["Barbarian Puppet", "Rage Vial", "Earthquake Boots", "Vampstache", "Giant Gauntlet", "Spiky Ball", "Snake Bracelet"],
    "Archer Queen": ["Archer Puppet", "Invisibility Vial", "Giant Arrow", "Healer Puppet", "Frozen Arrow", "Magic Mirror", "Action Figure", "Monolith Arrow"],
    "Minion Prince": ["Henchmen Puppet", "Dark Orb", "Metal Pants", "Noble Iron", "Dark Crown", "Meteor Staff"],
    "Grand Warden": ["Eternal Tome", "Life Gem", "Rage Gem", "Healing Tome", "Fireball", "Lavaloon Puppet", "Heroic Torch"],
    "Royal Champion": ["Royal Gem", "Seeking Shield", "Hog Rider Puppet", "Haste Vial", "Rocket Spear", "Electro Boots", "Frost Flake"],
    "Dragon Duke": ["Fire Heart", "Stun Blaster", "Rocket Backpack", "Electro Fangs", "Revenge Deck", "Flame Blower"]
};
const CACHE_CATALOGO_MS = 12 * 60 * 60 * 1000;

app.get("/ataques/catalogo", autenticarAdmin, async (request, response) => {
    if (cacheCatalogo.dados && Date.now() - cacheCatalogo.em < CACHE_CATALOGO_MS) {
        return response.status(200).json(cacheCatalogo.dados);
    }
    const headers = { 'Authorization': `Bearer ${process.env.CLASH_API_KEY}`, 'Accept': 'application/json' };

    try {
        const rMembros = await axios.get(`${api_base}/clans/${clan_tag}/members`, { headers });
        const tags = (rMembros.data?.items || [])
            .sort((a, b) => (b.townHallLevel || 0) - (a.townHallLevel || 0))
            .slice(0, 30)
            .map(m => m.tag);

        const porHeroi = {};
        const heroiDoEquip = {};   // nome do equipamento -> herói (aprendido de quem está usando)
        const naoEquipados = new Set();
        // 5 por vez para não estourar o limite de requisições da Supercell
        for (let i = 0; i < tags.length; i += 5) {
            const lote = await Promise.all(tags.slice(i, i + 5).map(tag =>
                axios.get(`${api_base}/players/${encodeURIComponent(tag)}`, { headers }).then(r => r.data).catch(() => null)));
            for (const j of lote) {
                for (const h of j?.heroes || []) {
                    if (h.village !== "home") continue;
                    for (const e of h.equipment || []) {
                        (porHeroi[h.name] = porHeroi[h.name] || new Set()).add(e.name);
                        heroiDoEquip[e.name] = h.name;
                    }
                }
                for (const e of j?.heroEquipment || []) {
                    if (e.village === "home") naoEquipados.add(e.name);
                }
            }
        }

        // Junta a lista conhecida + os que alguém tem mas não está usando
        for (const [heroi, lista] of Object.entries(EQUIP_POR_HEROI)) {
            lista.forEach(nome => {
                if (heroiDoEquip[nome] && heroiDoEquip[nome] !== heroi) return; // o jogo diz que é de outro herói
                (porHeroi[heroi] = porHeroi[heroi] || new Set()).add(nome);
                heroiDoEquip[nome] = heroiDoEquip[nome] || heroi;
            });
        }
        // Equipamento novo que ninguém equipou ainda e não está na lista conhecida
        naoEquipados.forEach(nome => {
            if (!heroiDoEquip[nome]) (porHeroi["Outros"] = porHeroi["Outros"] || new Set()).add(nome);
        });

        const dados = {
            jogadoresAnalisados: tags.length,
            herois: Object.fromEntries(Object.entries(porHeroi).map(([h, set]) => [h, [...set].sort()]))
        };
        cacheCatalogo = { em: Date.now(), dados };
        return response.status(200).json(dados);
    } catch (err) {
        console.error("[Ataques] Falha ao montar catálogo:", err.response?.status || err.message);
        return response.status(500).json({ erro: "Falha ao buscar os equipamentos." });
    }
});

// ============================================================
// ROTA EXTRA: BUSCAR DADOS ESPECÍFICOS DO JOGADOR NA SUPERCELL
// ============================================================
app.get("/jogador/:tag", async (request, response) => {
    try {
        const { tag } = request.params;
        const playerTag = encodeURIComponent(tag);

        if (!process.env.CLASH_API_KEY) {
            return response.status(500).json({ erro: "CLASH_API_KEY não configurada no arquivo .env" });
        }

        const apiResponse = await axios.get(`${api_base}/players/${playerTag}`, {
            headers: {
                'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        });

        return response.status(200).json(apiResponse.data);
    } catch (error) {
        console.error("Erro ao buscar perfil do jogador:", error.message);
        return response.status(500).json({ erro: "Falha ao obter dados do jogador." });
    }
});

// ============================================================
// ROTA 2: SINCRONIZAÇÃO COM A SUPERCELL E DISPARO DO WHATSAPP
// ============================================================
// ============================================================
// PROCESSAMENTO DE UMA GUERRA (avisos, ataques, ranking, defesas)
// Usado pela varredura normal e pela recuperação de guerra perdida.
// ============================================================
async function processarDadosGuerra(dadosGuerra) {
        const warId = dadosGuerra.preparationStartTime;

        // Notifica quando a guerra começa (preparação)
        if (dadosGuerra.state === "preparation") {
            // Gravado no banco para não repetir o aviso a cada varredura nem
            // depois de um reinício do servidor.
            const chaveNotif = `notif_inicio_${warId}`;
            const jaNotificou = await prisma.ataqueAnunciado.findUnique({ where: { idAtaque: chaveNotif } });
            if (!jaNotificou) {
                await prisma.ataqueAnunciado.create({ data: { idAtaque: chaveNotif } });
                await enviarNotificacaoPush(
                    '⚔️ GUERRA INICIADA!',
                    `Clash City BR vs ${dadosGuerra.opponent?.name || 'adversário'} — Período de preparação começou!`
                );
            }
        }

        // ALERTA DE FIM DE GUERRA
        if (dadosGuerra.state === "inWar") {
            const agora = new Date();
            // A Supercell manda a data como "20261006T080000.000Z" — o new Date()
            // puro não entende esse formato, por isso o parseDataCoC.
            const fimGuerra = liga.parseDataCoC(dadosGuerra.endTime);
            const diferencaHoras = fimGuerra ? (fimGuerra - agora) / (1000 * 60 * 60) : NaN;
            const HORAS_AVISO_FIM = 2;
            const HORAS_AVISO_PESSOAL = 3;

            // Aviso pessoal (Meu Painel): uma vez por guerra, com as contas que o celular segue
            if (diferencaHoras > 0 && diferencaHoras <= HORAS_AVISO_PESSOAL) {
                const idPessoal = `pp_pendente_${warId}`;
                const jaAvisouPessoal = await prisma.ataqueAnunciado.findUnique({ where: { idAtaque: idPessoal } });
                if (!jaAvisouPessoal) {
                    await prisma.ataqueAnunciado.create({ data: { idAtaque: idPessoal } });
                    const permitidos = dadosGuerra.attacksPerMember || 2;
                    const avisos = dadosGuerra.clan.members
                        .map(m => ({ tag: m.tag, nome: m.name, faltam: permitidos - (Array.isArray(m.attacks) ? m.attacks.length : 0) }))
                        .filter(a => a.faltam > 0);
                    const horas = Math.max(1, Math.round(diferencaHoras));
                    const plural = n => `${n} ${n === 1 ? "ataque" : "ataques"}`;
                    try {
                        await enviarPushPessoal(avisos, {
                            tipo: "pendente",
                            titulo: `⏰ Faltam ${horas}h pra guerra acabar`,
                            umaConta: a => `${a.nome} ainda tem ${plural(a.faltam)}. Bora garantir as estrelas!`,
                            variasContas: lista => `Ainda não atacaram: ${juntarNomes(lista.map(a => `${a.nome} (${plural(a.faltam)})`))}.`
                        });
                    } catch (err) { console.error("[Push pessoal] Pendentes:", err.message); }
                }
            }

            if (diferencaHoras > 0 && diferencaHoras <= HORAS_AVISO_FIM) {
                const ataquesPermitidos = dadosGuerra.attacksPerMember || 2;

                const membrosComAtaquePendente = dadosGuerra.clan.members.filter(m => {
                    const ataquesFeitos = Array.isArray(m.attacks) ? m.attacks.length : 0;
                    return ataquesFeitos < ataquesPermitidos;
                });

                // Um aviso só por guerra: fica gravado no banco, então as próximas
                // varreduras (a cada 15 min) não repetem a mensagem.
                const idAviso = `aviso_fim_${warId}`;
                const jaAvisou = await prisma.ataqueAnunciado.findUnique({ where: { idAtaque: idAviso } });

                if (membrosComAtaquePendente.length > 0 && !jaAvisou) {
                    await prisma.ataqueAnunciado.create({ data: { idAtaque: idAviso } });

                    let mensagem = `⚠️ *AVISO DE GUERRA URGEEEENTE* ⚠️\n`;
                    mensagem += `Faltam menos de *${HORAS_AVISO_FIM} horas* para acabar a guerra atual!\n\n`;
                    mensagem += `Os seguintes membros ainda possuem ataques pendentes:\n\n`;

                    membrosComAtaquePendente.forEach(m => {
                        const ataquesFeitos = Array.isArray(m.attacks) ? m.attacks.length : 0;
                        const pendentes = ataquesPermitidos - ataquesFeitos;
                        mensagem += `• *${m.name}* (Falta ${pendentes} ataque${pendentes > 1 ? 's' : ''})\n`;
                    });

                    mensagem += `\nPrograme seu ataque para garantir o PT. Não prejudique o clã seu Bagre! 🏰⚔️`;
                    await enviarMensagemWhatsApp(mensagem);

                    // Push notification
                    const nomesPendentes = membrosComAtaquePendente.map(m => m.name).join(', ');
                    await enviarNotificacaoPush(
                        '⚠️ Ataques pendentes!',
                        `Faltam menos de ${HORAS_AVISO_FIM}h! ${nomesPendentes} ainda não atacaram.`
                    );
                }
            }
        }

        // PROCESSAMENTO DE ATAQUES E BANCO DE DADOS
        const membros = dadosGuerra.clan.members;
        const guerraTerminou = dadosGuerra.state === "warEnded";
        const mesGuerra = `${warId.slice(0, 4)}-${warId.slice(4, 6)}`;
        const hoje = new Date();
        const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
        const temporadaFechada = mesGuerra !== mesAtual
            && await prisma.temporada.findUnique({ where: { mes: mesGuerra } });
        for (const player of membros) {
            const existente = await prisma.membro.findUnique({ where: { tag: player.tag } });
            if (!existente) {
                await prisma.membro.create({
                    data: {
                        tag: player.tag,
                        nome: player.name,
                        cv: player.townhallLevel,
                        status: "titular",
                        totalEstrelas: 0,
                        totalDestruicao: 0,
                        guerras: 0,
                        guerrasIds: []
                    }
                });
            } else {
                await prisma.membro.update({
                    where: { tag: player.tag },
                    data: { nome: player.name, cv: player.townhallLevel }
                });
            }

            if (player.attacks) {
                for (const ataque of player.attacks) {
                    const idAtaque = `${player.tag}_${warId}_${ataque.order}`;

                    const jaRegistrado = await prisma.ataqueRegistrado.findUnique({ where: { idAtaque } });

                    if (!jaRegistrado) {
                        await prisma.ataqueRegistrado.create({
                            data: {
                                idAtaque,
                                tagJogador: player.tag,
                                warId,
                                estrelas: ataque.stars,
                                destruicao: ataque.destructionPercentage
                            }
                        });
                        console.log(`[ATAQUE] ${player.name} — ${ataque.stars}⭐ ${ataque.destructionPercentage}% salvo.`);
                        if (ataque.stars === 3) {
                            try { await avisarSequenciaTriplas(player.tag, player.name); }
                            catch (err) { console.error("[Push pessoal] Sequência:", err.message); }
                        }
                    }

                    // VERIFICAÇÃO DE BAGRE
                    if (ataque.stars <= 1) {
                        const idBagre = `bagre_${warId}_${player.tag}_${ataque.order}`;
                        const jaAnunciadoBagre = await prisma.ataqueBagreAnunciado.findUnique({ where: { idAtaque: idBagre } });

                        if (!jaAnunciadoBagre) {
                            const estrelasTxt = ataque.stars === 1 ? '1 estrela' : '0 estrelas';
                            let msgBagre = `🚨 *BAGRE DETECTADO!* 🚨\n\n`;
                            msgBagre += `*${player.name}* acabou de atacar com o celular na bunda e fez *${estrelasTxt}*!\n`;
                            msgBagre += `_(${ataque.destructionPercentage.toFixed(0)}% de destruição)_ 💀😂`;

                            await enviarMensagemWhatsApp(msgBagre);
                            await prisma.ataqueBagreAnunciado.create({ data: { idAtaque: idBagre } });
                        }
                    }
                }
            }

            if (!guerraTerminou) continue;
            if (temporadaFechada) continue; // não conta no mês atual

            const membroAtual = await prisma.membro.findUnique({ where: { tag: player.tag } });
            const guerraJaProcessada = membroAtual?.guerrasIds?.includes(warId) ?? false;

            if (guerraJaProcessada) {
                console.log(`[SKIP] Guerra ${warId} já processada para ${player.name}.`);
                continue;
            }

            const ataquesRegistrados = await prisma.ataqueRegistrado.findMany({
                where: { tagJogador: player.tag, warId }
            });

            const totalEstrelas = ataquesRegistrados.reduce((acc, a) => acc + a.estrelas, 0);
            const totalDestruicao = ataquesRegistrados.reduce((acc, a) => acc + a.destruicao, 0);

            await prisma.membro.update({
                where: { tag: player.tag },
                data: {
                    totalEstrelas: { increment: totalEstrelas },
                    totalDestruicao: { increment: totalDestruicao },
                    guerras: { increment: 1 },
                    guerrasIds: { push: warId }
                }
            });

            console.log(`[OK] ${player.name} — ${totalEstrelas}⭐ | ${totalDestruicao.toFixed(1)}% registrados.`);
        }
         if (guerraTerminou && temporadaFechada) {
            await somarGuerraNoHistorico(dadosGuerra, warId, mesGuerra);
        }
        if (guerraTerminou) {
            registrarDefesasDaGuerra(dadosGuerra, warId, mesGuerra);
            const novaNoDetalhe = registrarGuerraDetalhada(dadosGuerra, warId);
            if (novaNoDetalhe) {
                try { await avisarFimDeGuerraPessoal(warId); }
                catch (err) { console.error("[Push pessoal] Fim de guerra:", err.message); }
            }
        }


}

// ------------------------------------------------------------
// FOTO DA GUERRA: a cada varredura durante a batalha guarda a guerra
// inteira num arquivo. Se a guerra acabar e a próxima começar antes da
// varredura ver o "encerrada", a foto permite gravar a guerra mesmo assim
// (no pior caso faltam os ataques dos últimos minutos).
// ------------------------------------------------------------
const ARQUIVO_FOTO_GUERRA = path.join(__dirname, "ultima-guerra.json");

function salvarFotoGuerra(dadosGuerra) {
    try {
        const temporario = `${ARQUIVO_FOTO_GUERRA}.tmp`;
        fs.writeFileSync(temporario, JSON.stringify(dadosGuerra));
        fs.renameSync(temporario, ARQUIVO_FOTO_GUERRA);
    } catch (err) {
        console.error("[Foto da guerra] Não foi possível salvar:", err.message);
    }
}

function lerFotoGuerra() {
    try { return JSON.parse(fs.readFileSync(ARQUIVO_FOTO_GUERRA, "utf8")); }
    catch (err) { return null; }
}

async function recuperarGuerraPerdida(dadosAtuais) {
    const foto = lerFotoGuerra();
    const warIdFoto = foto?.preparationStartTime;
    if (!warIdFoto) return;
    if (dadosAtuais?.preparationStartTime === warIdFoto) return;   // ainda é a mesma guerra

    // Já foi gravada? (fica marcada nas defesas do mês)
    const mesFoto = `${warIdFoto.slice(0, 4)}-${warIdFoto.slice(4, 6)}`;
    if (defesas[mesFoto]?.guerras?.includes(warIdFoto)) return;

    console.log(`[Recuperação] Guerra ${warIdFoto} (vs ${foto.opponent?.name}) acabou sem a varredura ver. Gravando com a última foto...`);
    await processarDadosGuerra({ ...foto, state: "warEnded" });
}

app.post("/sincronizar-guerra", async (request, response) => {
    try {

        if (!process.env.CLASH_API_KEY) {
            return response.status(500).json({ erro: "CLASH_API_KEY não configurada." });
        }

        console.log("[DEBUG] Disparando requisição para a Supercell...");

        const apiResponse = await axios.get(`${api_base}/clans/${clan_tag}/currentwar`, {
            headers: {
                'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const dadosGuerra = apiResponse.data;

        if (dadosGuerra.state === "notInWar") {
            try { await recuperarGuerraPerdida(dadosGuerra); }
            catch (err) { console.error("[Recuperação] Falha:", err.message); }
            return response.status(400).json({ mensagem: "Nenhuma guerra ativa encontrada no momento." });
        }

        // Se uma guerra acabou e a próxima começou entre duas varreduras, a
        // anterior nunca apareceu como "encerrada". Grava ela com a última foto.
        try { await recuperarGuerraPerdida(dadosGuerra); }
        catch (err) { console.error("[Recuperação] Falha:", err.message); }

        if (dadosGuerra.state === "inWar" || dadosGuerra.state === "warEnded") salvarFotoGuerra(dadosGuerra);

        await processarDadosGuerra(dadosGuerra);

        return response.status(200).json({ mensagem: "Desempenho de guerra atualizado com sucesso!" });

    } catch (error) {
        console.error("Erro interno:", error.message);
        console.error("Status Supercell:", error.response?.status);
        console.error("Dados Supercell:", JSON.stringify(error.response?.data));
        return response.status(500).json({ erro: "Falha interna na sincronização.", detalhe: error.message });
    }
});

// ============================================================
// CRON: histórico da Liga — a cada 30 min guarda a liga dos 3 clãs
// (fora da temporada a Supercell só responde "não está em liga")
// ============================================================
cron.schedule("10,40 * * * *", async () => {
    try { await liga.atualizarHistoricoLiga(); }
    catch (err) { console.error("[LIGA] Histórico:", err.message); }
});
setTimeout(() => liga.atualizarHistoricoLiga().catch(() => {}), 60 * 1000);

// ============================================================
// CRON: evolução da conta — foto diária de cada membro (5h de Brasília)
// e uma tentativa 2 min depois de ligar, caso o dia ainda não tenha foto
// ============================================================
cron.schedule("0 5 * * *", () => {
    registrarEvolucaoDiaria().catch(err => console.error("[Evolução]", err.message));
}, { timezone: "America/Sao_Paulo" });
setTimeout(() => registrarEvolucaoDiaria().catch(() => {}), 2 * 60 * 1000);

// ============================================================
// CRON: roda a cada 15 minutos
// ============================================================
cron.schedule("*/15 * * * *", async () => {
    console.log("Iniciando varredura automatizada na API da Supercell...");
    try {
        await axios.post(`http://localhost:3333/sincronizar-guerra`);
        console.log("Varredura automatizada concluída com sucesso.");
    } catch (err) {
        console.error("Aviso da varredura automatizada:", err.response?.data?.mensagem || err.message);
    }

    // Alertas da Liga (bagre e fim de rodada) — só fazem algo se o clã estiver em Liga
    try {
        const resumo = await liga.sincronizarAlertasDaLiga();
        if (resumo.emLiga && (resumo.bagres.length > 0 || resumo.avisoFim)) {
            console.log(`[LIGA] Alertas: ${resumo.bagres.length} bagre(s)${resumo.avisoFim ? ' + aviso de fim de rodada' : ''}${resumo.primeiraVez ? ' (primeira varredura: só registrado, sem enviar)' : ''}.`);
        }
    } catch (err) {
        console.error("[LIGA] Falha na varredura de alertas:", err.response?.status || err.message);
    }
});

// ============================================================
// CRON MENSAL: todo dia 1 às 00:05
// ============================================================
cron.schedule("5 0 1 * *", async () => {
    console.log("[CRON MENSAL] Iniciando fechamento de temporada...");
    try {
        await axios.post(`http://localhost:3333/fechar-temporada`, {}, {
            headers: { 'x-admin-key': process.env.ADMIN_KEY }
        });
        console.log("[CRON MENSAL] Temporada fechada com sucesso.");
    } catch (err) {
        console.error("[CRON MENSAL] Erro ao fechar temporada:", err.response?.data || err.message);
    }
});
// ============================================================
// ROTA: PROCESSAR WARLOG
// ============================================================
app.post("/processar-warlog", autenticarAdmin, async (request, response) => {
    try {
        const apiResponse = await axios.get(`${api_base}/clans/${clan_tag}/warlog?limit=1`, {
            headers: {
                'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const wars = apiResponse.data?.items;
        if (!wars || wars.length === 0) {
            return response.status(404).json({ erro: "Nenhuma guerra encontrada no warlog." });
        }

        const ultimaGuerra = wars[0];
        const warId = ultimaGuerra.endTime;
        const membros = ultimaGuerra.clan.members;
        let processados = 0, pulados = 0;

        for (const player of membros) {
            const membroExistente = await prisma.membro.findUnique({ where: { tag: player.tag } });
            const guerraJaProcessada = membroExistente?.guerrasIds?.includes(warId) ?? false;

            if (guerraJaProcessada) { pulados++; continue; }

            const estrelasNestaGuerra = player.attacks ? player.attacks.reduce((acc, a) => acc + a.stars, 0) : 0;
            const destruicaoNestaGuerra = player.attacks ? player.attacks.reduce((acc, a) => acc + a.destructionPercentage, 0) : 0;

            await prisma.membro.upsert({
                where: { tag: player.tag },
                update: {
                    nome: player.name,
                    cv: player.townhallLevel,
                    totalEstrelas: { increment: estrelasNestaGuerra },
                    totalDestruicao: { increment: destruicaoNestaGuerra },
                    guerras: { increment: 1 },
                    guerrasIds: { push: warId }
                },
                create: {
                    tag: player.tag,
                    nome: player.name,
                    cv: player.townhallLevel,
                    status: "titular",
                    totalEstrelas: estrelasNestaGuerra,
                    totalDestruicao: destruicaoNestaGuerra,
                    guerras: 1,
                    guerrasIds: [warId]
                }
            });
            processados++;
        }

        return response.status(200).json({ mensagem: `Warlog processado! ${processados} atualizados, ${pulados} já registrados.` });
    } catch (error) {
        return response.status(500).json({ erro: "Falha ao processar warlog.", detalhe: error.message });
    }
});

// ============================================================
// ROTA: FECHAR TEMPORADA
// ============================================================
app.post("/fechar-temporada", autenticarAdmin, async (request, response) => {
    try {
        const membros = await prisma.membro.findMany({ orderBy: { totalEstrelas: "desc" } });

        if (membros.length === 0) {
            return response.status(400).json({ mensagem: "Nenhum membro encontrado para arquivar." });
        }

        const agora = new Date();
        const mesAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
        const mes = `${mesAnterior.getFullYear()}-${String(mesAnterior.getMonth() + 1).padStart(2, '0')}`;

        const existente = await prisma.temporada.findUnique({ where: { mes } });
        if (existente && request.query.forcar !== "1") {
            return response.status(409).json({ erro: `Temporada ${mes} já foi arquivada. Use ?forcar=1 para sobrescrever.` });
        }
        // Só entra no arquivo do mês quem participou de pelo menos uma guerra.
        // Quem saiu do clã (ou não guerreou) continua na tabela de membros,
        // mas não aparece no ranking arquivado com tudo zerado.
        const snapshot = ordenarRanking(membros.filter(m => m.guerras > 0).map((m) => ({
            tag: m.tag,
            nome: m.nome,
            cv: m.cv,
            status: m.status,
            totalEstrelas: m.totalEstrelas,
            totalDestruicao: m.totalDestruicao,
            guerras: m.guerras,
            mediaEstrelas: m.guerras > 0 ? parseFloat((m.totalEstrelas / m.guerras).toFixed(2)) : 0,
            mediaPorcentagem: m.guerras > 0 ? parseFloat(((m.totalDestruicao / m.guerras) / 2).toFixed(2)) : 0
        })));

        await prisma.temporada.upsert({ where: { mes }, update: { snapshot }, create: { mes, snapshot } });
        await prisma.membro.updateMany({ data: { totalEstrelas: 0, totalDestruicao: 0, guerras: 0, guerrasIds: [] } });
        await prisma.ataqueAnunciado.deleteMany({});
        await prisma.ataqueBagreAnunciado.deleteMany({});

        console.log(`[TEMPORADA] Mês ${mes} arquivado com ${snapshot.length} participantes (de ${membros.length} membros no banco).`);
        return response.status(200).json({ mensagem: `Temporada ${mes} arquivada com sucesso!`, membrosArquivados: snapshot.length });
    } catch (error) {
        return response.status(500).json({ erro: "Falha ao fechar temporada.", detalhe: error.message });
    }
});

// ============================================================
// ROTA: HISTÓRICO
// ============================================================
app.get("/historico", async (request, response) => {
    try {
        const temporadas = await prisma.temporada.findMany({ orderBy: { mes: "desc" } });
        // Meses antigos foram arquivados por total de estrelas e com quem não
        // guerreou. Aqui tudo sai no critério atual, sem alterar o que está no banco.
        return response.status(200).json(
            temporadas.map(t => ({ ...t, snapshot: ordenarRanking(t.snapshot) }))
        );
    } catch (error) {
        return response.status(500).json({ erro: error.message });
    }
});

app.get("/historico/:mes", async (request, response) => {
    try {
        const { mes } = request.params;
        const temporada = await prisma.temporada.findUnique({ where: { mes } });
        if (!temporada) return response.status(404).json({ erro: "Temporada não encontrada." });
        return response.status(200).json({ ...temporada, snapshot: ordenarRanking(temporada.snapshot) });
    } catch (error) {
        return response.status(500).json({ erro: error.message });
    }
});

// ============================================================
// ROTA: ZERAR BANCO
// ============================================================
app.delete("/limpar-banco", autenticarAdmin, async (request, response) => {
    try {
        await prisma.membro.deleteMany({});
        return response.status(200).json({ mensagem: "Banco de dados resetado com sucesso!" });
    } catch (error) {
        return response.status(500).json({ erro: error.message });
    }
});

// ============================================================
// ROTA PROXY: INSTAGRAM
// ============================================================
app.get('/api/instagram', async (req, res) => {
    try {
        const instagramResponse = await fetch('https://feeds.behold.so/zfNu73cvSfwyTTz5ynmT');
        if (!instagramResponse.ok) return res.status(instagramResponse.status).json({ error: 'Erro ao buscar dados no Behold' });
        const dados = await instagramResponse.json();
        res.json(dados);
    } catch (error) {
        res.status(500).json({ error: 'Erro interno no servidor backend' });
    }
});

// ============================================================
// ROTAS: CONVOCAÇÃO CWL
// ============================================================

// GET — retorna convocação de um clã
app.get("/cwl/:cla", async (req, res) => {
    try {
        const { cla } = req.params;
        const convocacao = await prisma.convocacaoCWL.findUnique({ where: { cla } });

        if (!convocacao) {
            return res.status(200).json({ cla, tamanho: 15, membros: [] });
        }

        // Busca dados dos membros — tenta no banco primeiro, senão usa dados básicos
        const dadosMembros = await prisma.membro.findMany({
            where: { tag: { in: convocacao.membros } }
        });

        // Quem não está no banco: procura nos clãs da família e no parceiro (o convocado pode
        // estar em qualquer um) e, se ainda faltar, busca o jogador direto pela tag
        const headersCoc = {
            'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
            'Accept': 'application/json'
        };
        const daFamilia = new Map();
        const faltando = convocacao.membros.filter(tag => !dadosMembros.some(m => m.tag === tag));
        if (faltando.length) {
            // 3 clãs da família + o parceiro TOP 1 BR
            for (const tagCla of new Set([...Object.values(liga.CLAS_LIGA), "#2CYRC8VQL"])) {
                try {
                    const r = await axios.get(`${api_base}/clans/${encodeURIComponent(tagCla)}/members`, { headers: headersCoc });
                    for (const m of r.data?.items || []) daFamilia.set(m.tag, { tag: m.tag, nome: m.name, cv: m.townHallLevel, guerras: 0 });
                } catch (e) { }
            }
            for (const tag of faltando) {
                if (daFamilia.has(tag)) continue;
                try {
                    const p = (await axios.get(`${api_base}/players/${encodeURIComponent(tag)}`, { headers: headersCoc })).data;
                    daFamilia.set(tag, { tag, nome: p.name, cv: p.townHallLevel, guerras: 0 });
                } catch (e) { }
            }
        }

        // Mantém a ordem original da convocação
        const membrosOrdenados = convocacao.membros.map(tag =>
            dadosMembros.find(m => m.tag === tag) || daFamilia.get(tag) || null
        ).filter(Boolean);

        return res.status(200).json({
            cla: convocacao.cla,
            tamanho: convocacao.tamanho,
            membros: membrosOrdenados,
            atualizadoEm: convocacao.atualizadoEm
        });
    } catch (error) {
        return res.status(500).json({ erro: error.message });
    }
});

// POST — salva convocação (admin)
app.post("/cwl/:cla", autenticarAdmin, async (req, res) => {
    try {
        const { cla } = req.params;
        const { membros, tamanho } = req.body;

        if (!Array.isArray(membros)) {
            return res.status(400).json({ erro: "membros deve ser um array de tags." });
        }

        const convocacao = await prisma.convocacaoCWL.upsert({
            where: { cla },
            update: { membros, tamanho: tamanho || 15, atualizadoEm: new Date() },
            create: { cla, membros, tamanho: tamanho || 15 }
        });

        return res.status(200).json({ mensagem: "Convocação salva com sucesso!", convocacao });
    } catch (error) {
        return res.status(500).json({ erro: error.message });
    }
});

// DELETE — limpa convocação de um clã (admin)
app.delete("/cwl/:cla", autenticarAdmin, async (req, res) => {
    try {
        const { cla } = req.params;
        await prisma.convocacaoCWL.upsert({
            where: { cla },
            update: { membros: [], atualizadoEm: new Date() },
            create: { cla, membros: [], tamanho: 15 }
        });
        return res.status(200).json({ mensagem: "Convocação limpa com sucesso!" });
    } catch (error) {
        return res.status(500).json({ erro: error.message });
    }
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================
app.listen(3333, () => {
    console.log("Servidor Express rodando na porta 3333!");
    setTimeout(() => {
        console.log("Iniciando o subsistema do WhatsApp com Baileys...");
        conectarWhatsApp();
    }, 3000);
});
