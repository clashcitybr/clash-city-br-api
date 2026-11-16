// ============================================================
// LIGA DE CLÃS (CWL) — guerras, placar por rodada e classificação
//
// Durante a Liga, o endpoint normal /currentwar da Supercell responde
// "notInWar". As guerras da Liga ficam em outros dois endpoints:
//   /clans/{tag}/currentwar/leaguegroup   → grupo, clãs e rodadas
//   /clanwarleagues/wars/{warTag}         → cada guerra da rodada
//
// Este módulo junta tudo e devolve já pronto pro front-end.
// Uso no server.js:
//   const liga = require("./liga-guerras");
//   liga.registrarRotasLiga(app, { axios, apiBase: api_base });
// ============================================================

const fs = require("fs");
const path = require("path");

const CLAS_LIGA = {
    principal: "#GUPJU0L2",
    cla2: "#2LQY9RYV0",
    cla3: "#2JY8QGQC8",
    parceiro: "#2CYRC8VQL"     // TOP 1 BR: a liderança também monta a convocação deles
};

// Guerra em andamento muda a cada ataque, então o cache é curto.
// Guerra encerrada nunca mais muda — fica guardada até o servidor reiniciar.
const CACHE_MS = 3 * 60 * 1000;

let http = null;       // axios, injetado pelo server.js
let apiBase = null;

// Usados só pelos alertas (WhatsApp / push). Também vêm do server.js.
let prisma = null;
let enviarWhatsApp = null;
let enviarPush = null;

const HORAS_AVISO_FIM = 2;                    // avisa quando faltar isso ou menos
const MARCADOR_ALERTAS = 'liga_alertas_ativados';

const cacheLiga = new Map();              // cla -> { em, dados }

// ------------------------------------------------------------
// HISTÓRICO DA LIGA: a Supercell apaga a liga quando a temporada acaba,
// então cada vez que os dados são montados guardamos uma cópia por
// temporada e por clã. Fica num arquivo próprio, sem mexer no banco.
// ------------------------------------------------------------
const ARQUIVO_HISTORICO = path.join(__dirname, "liga-historico.json");

function carregarHistorico() {
    try {
        const d = JSON.parse(fs.readFileSync(ARQUIVO_HISTORICO, "utf8"));
        return d && typeof d === "object" ? d : {};
    } catch (err) {
        return {};
    }
}
let historicoLiga = carregarHistorico();

function salvarHistorico() {
    try {
        const tmp = `${ARQUIVO_HISTORICO}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(historicoLiga));
        fs.renameSync(tmp, ARQUIVO_HISTORICO);
    } catch (err) {
        console.error("[LIGA] Não foi possível salvar o histórico:", err.message);
    }
}

function arquivarLiga(dados) {
    if (!dados?.emLiga || !dados.temporada) return;
    const encerradas = (dados.rodadas || []).filter(r => r.estado === 'warEnded').length;
    if (!encerradas) return;   // nada pra guardar ainda

    const daTemporada = historicoLiga[dados.temporada] || (historicoLiga[dados.temporada] = {});
    const salvo = daTemporada[dados.cla];
    // Nunca troca uma cópia mais completa por uma menos completa
    if (salvo && salvo.rodadasEncerradas > encerradas) return;
    if (salvo && salvo.rodadasEncerradas === encerradas && salvo.estado === dados.estado) return;

    const { _guerraAtual, _guerras, ...publico } = dados;
    daTemporada[dados.cla] = { ...publico, rodadasEncerradas: encerradas, arquivadoEm: new Date().toISOString() };
    salvarHistorico();
    console.log(`[LIGA] Histórico ${dados.temporada} (${dados.cla}): ${encerradas} rodada(s) encerrada(s) guardadas.`);
}

// Chamado pelo cron do server.js: mantém o histórico em dia mesmo se ninguém abrir a página
async function atualizarHistoricoLiga() {
    for (const cla of Object.keys(CLAS_LIGA)) {
        try { await obterLiga(cla); }
        catch (err) { console.error(`[LIGA] Histórico ${cla}:`, err.response?.status || err.message); }
    }
}
const emAndamento = new Map();            // cla -> Promise (evita buscas duplicadas)
const cacheGuerras = new Map();           // warTag -> { em, guerra }

function cabecalhos() {
    return {
        'Authorization': `Bearer ${process.env.CLASH_API_KEY}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
}

async function cocGet(caminho) {
    const resp = await http.get(`${apiBase}${caminho}`, { headers: cabecalhos() });
    return resp.data;
}

// Formato da Supercell: yyyyMMddTHHmmss.000Z — o new Date() puro não entende.
function parseDataCoC(str) {
    if (!str || str.length < 15) return null;
    const d = new Date(`${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}T${str.slice(9, 11)}:${str.slice(11, 13)}:${str.slice(13, 15)}Z`);
    return isNaN(d) ? null : d;
}

async function buscarGuerraDaLiga(warTag) {
    const salvo = cacheGuerras.get(warTag);
    if (salvo && (salvo.guerra.state === 'warEnded' || Date.now() - salvo.em < CACHE_MS)) {
        return salvo.guerra;
    }
    const guerra = await cocGet(`/clanwarleagues/wars/${encodeURIComponent(warTag)}`);
    cacheGuerras.set(warTag, { em: Date.now(), guerra });
    return guerra;
}

function resultadoDe(nos, adversario) {
    if (nos.stars !== adversario.stars) return nos.stars > adversario.stars ? 'vitoria' : 'derrota';
    if (nos.destructionPercentage !== adversario.destructionPercentage) {
        return nos.destructionPercentage > adversario.destructionPercentage ? 'vitoria' : 'derrota';
    }
    return 'empate';
}

function resumoLado(lado) {
    return {
        tag: lado.tag,
        nome: lado.name,
        estrelas: lado.stars ?? 0,
        destruicao: +(lado.destructionPercentage ?? 0).toFixed(1),
        ataques: lado.attacks ?? 0
    };
}

// ------------------------------------------------------------
// RAIO-X: compara os dois times de uma rodada e resume como cada clã
// do grupo está atacando e defendendo. Usa só as guerras que já são
// buscadas para a classificação — nenhuma chamada extra à API.
// ------------------------------------------------------------
const FAIXAS_CV = [18, 17, 16];   // o resto vira "15 ou menos"

function distribuicaoCV(cvs) {
    const d = { cv18: 0, cv17: 0, cv16: 0, cv15menos: 0 };
    for (const cv of cvs) {
        if (cv >= 18) d.cv18++;
        else if (cv === 17) d.cv17++;
        else if (cv === 16) d.cv16++;
        else d.cv15menos++;
    }
    return d;
}

function perfilDoTime(membros) {
    const ordem = [...(membros || [])].sort((a, b) => (a.mapPosition || 0) - (b.mapPosition || 0));
    const cvs = ordem.map(m => m.townhallLevel || 0);
    return {
        tamanho: cvs.length,
        cvMedio: cvs.length ? +(cvs.reduce((n, c) => n + c, 0) / cvs.length).toFixed(1) : 0,
        distribuicao: distribuicaoCV(cvs),
        cvs
    };
}

function novaEstat() {
    return { ataques: 0, triplas: 0, estrelas: 0, destruicao: 0, defesas: 0, triplasSofridas: 0, jogadores: new Map() };
}

function somarGuerra(estat, lado, outro) {
    const e = estat.get(lado.tag);
    if (!e) return;
    for (const m of lado.members || []) {
        for (const a of m.attacks || []) {
            e.ataques++;
            e.estrelas += a.stars || 0;
            e.destruicao += a.destructionPercentage || 0;
            if (a.stars === 3) e.triplas++;
            const j = e.jogadores.get(m.tag) || { nome: m.name, cv: m.townhallLevel, ataques: 0, triplas: 0, estrelas: 0 };
            j.nome = m.name; j.cv = m.townhallLevel;
            j.ataques++; j.estrelas += a.stars || 0; if (a.stars === 3) j.triplas++;
            e.jogadores.set(m.tag, j);
        }
    }
    // Defesa: quantas bases deste lado o outro lado derrubou com 3★
    for (const m of outro.members || []) {
        for (const a of m.attacks || []) {
            e.defesas++;
            if (a.stars === 3) e.triplasSofridas++;
        }
    }
}

function resumoEstat(e) {
    if (!e) return null;
    const pct = (a, b) => (b ? Math.round(a / b * 100) : null);
    const destaques = [...e.jogadores.values()]
        .filter(j => j.ataques > 0)
        .sort((a, b) => b.triplas - a.triplas || b.estrelas - a.estrelas || b.cv - a.cv)
        .slice(0, 3)
        .map(j => ({ nome: j.nome, cv: j.cv, ataques: j.ataques, triplas: j.triplas }));
    return {
        ataques: e.ataques,
        taxaTripla: pct(e.triplas, e.ataques),
        mediaEstrelas: e.ataques ? +(e.estrelas / e.ataques).toFixed(2) : null,
        mediaDestruicao: e.ataques ? +(e.destruicao / e.ataques).toFixed(1) : null,
        defesas: e.defesas,
        taxaTriplaSofrida: pct(e.triplasSofridas, e.defesas),
        destaques
    };
}

function montarRaioX(nos, adversario, estat) {
    const a = perfilDoTime(nos.members), b = perfilDoTime(adversario.members);
    const espelho = [];
    let vantagemNos = 0, vantagemEles = 0;
    for (let i = 0; i < Math.max(a.cvs.length, b.cvs.length); i++) {
        const nosCv = a.cvs[i] ?? null, elesCv = b.cvs[i] ?? null;
        espelho.push({ posicao: i + 1, nos: nosCv, eles: elesCv });
        if (nosCv != null && elesCv != null) {
            if (nosCv > elesCv) vantagemNos++;
            else if (elesCv > nosCv) vantagemEles++;
        }
    }
    const { cvs: _a, ...nosResumo } = a;
    const { cvs: _b, ...elesResumo } = b;
    return {
        nos: nosResumo,
        eles: elesResumo,
        espelho,
        vantagemNos,
        vantagemEles,
        adversarioNaLiga: resumoEstat(estat.get(adversario.tag)),
        nosNaLiga: resumoEstat(estat.get(nos.tag))
    };
}

// ------------------------------------------------------------
// Monta tudo de um clã: rodadas, guerra atual, classificação do
// grupo e desempenho individual.
// ------------------------------------------------------------
async function montarLiga(cla) {
    const tag = CLAS_LIGA[cla];

    let grupo;
    try {
        grupo = await cocGet(`/clans/${encodeURIComponent(tag)}/currentwar/leaguegroup`);
    } catch (err) {
        // 404 = o clã não está em Liga neste momento
        if (err.response?.status === 404) return { emLiga: false, cla };
        // 403 = histórico de guerra do clã está privado no jogo
        if (err.response?.status === 403) return { emLiga: false, cla, privado: true };
        throw err;
    }

    if (!grupo || !Array.isArray(grupo.rounds) || grupo.state === 'notInWar') {
        return { emLiga: false, cla };
    }

    // Tabela do grupo (todos os clãs começam zerados)
    const tabela = new Map();
    for (const c of grupo.clans || []) {
        tabela.set(c.tag, {
            tag: c.tag, nome: c.name, estrelas: 0, destruicaoTotal: 0,
            guerras: 0, vitorias: 0, derrotas: 0, empates: 0, nosso: c.tag === tag
        });
    }

    const estat = new Map((grupo.clans || []).map(c => [c.tag, novaEstat()]));
    const rodadas = [];
    const jogadores = new Map();
    const guerrasNossas = [];   // guerras completas do nosso clã, já normalizadas

    for (let i = 0; i < grupo.rounds.length; i++) {
        const tags = (grupo.rounds[i].warTags || []).filter(t => t && t !== '#0');
        const numero = i + 1;

        if (tags.length === 0) {
            rodadas.push({ rodada: numero, estado: 'aguardando' });
            continue;
        }

        const guerras = await Promise.all(tags.map(t => buscarGuerraDaLiga(t).catch(() => null)));
        let achouNossa = false;

        for (let k = 0; k < guerras.length; k++) {
            const g = guerras[k];
            if (!g || !g.clan || !g.opponent) continue;

            // --- Classificação do grupo ---
            if (g.state === 'inWar' || g.state === 'warEnded') {
                const pares = [[g.clan, g.opponent], [g.opponent, g.clan]];
                for (const [lado, outro] of pares) {
                    const linha = tabela.get(lado.tag);
                    if (!linha) continue;
                    linha.estrelas += lado.stars ?? 0;
                    linha.destruicaoTotal += (lado.destructionPercentage ?? 0) * (g.teamSize || 15);
                    somarGuerra(estat, lado, outro);
                    if (g.state === 'warEnded') {
                        linha.guerras += 1;
                        const r = resultadoDe(lado, outro);
                        if (r === 'vitoria') { linha.vitorias += 1; linha.estrelas += 10; } // bônus de vitória
                        else if (r === 'derrota') linha.derrotas += 1;
                        else linha.empates += 1;
                    }
                }
            }

            // --- É a nossa guerra nesta rodada? ---
            const somosClan = g.clan.tag === tag;
            const somosOpponent = g.opponent.tag === tag;
            if (!somosClan && !somosOpponent) continue;
            achouNossa = true;

            const nos = somosClan ? g.clan : g.opponent;
            const adversario = somosClan ? g.opponent : g.clan;
            const membros = nos.members || [];

            const rodada = {
                rodada: numero,
                estado: g.state,                    // preparation | inWar | warEnded
                inicio: g.startTime,
                fim: g.endTime,
                tamanho: g.teamSize,
                nos: resumoLado(nos),
                adversario: resumoLado(adversario),
                resultado: g.state === 'warEnded' ? resultadoDe(nos, adversario) : null,
                pendentes: g.state === 'inWar'
                    ? membros.filter(m => !m.attacks || m.attacks.length === 0).map(m => ({ tag: m.tag, nome: m.name }))
                    : []
            };
            rodada._lados = { nos, adversario };   // raio-x é montado no fim, com o grupo todo somado
            rodadas.push(rodada);

            // Guerra no mesmo formato da guerra normal (pro card da home)
            guerrasNossas.push({
                ...g,
                clan: nos,
                opponent: adversario,
                attacksPerMember: 1,
                warTag: tags[k],
                liga: { cla, rodada: numero, totalRodadas: grupo.rounds.length }
            });

            // --- Desempenho individual (só guerras que já começaram) ---
            if (g.state === 'inWar' || g.state === 'warEnded') {
                for (const m of membros) {
                    let j = jogadores.get(m.tag);
                    if (!j) {
                        j = { tag: m.tag, nome: m.name, cv: m.townhallLevel, guerras: 0, ataques: 0, estrelas: 0, destruicaoTotal: 0, faltas: 0 };
                        jogadores.set(m.tag, j);
                    }
                    j.nome = m.name;
                    j.cv = m.townhallLevel;
                    j.guerras += 1;
                    const ataque = (m.attacks || [])[0];
                    if (ataque) {
                        j.ataques += 1;
                        j.estrelas += ataque.stars;
                        j.destruicaoTotal += ataque.destructionPercentage;
                    } else if (g.state === 'warEnded') {
                        j.faltas += 1;
                    }
                }
            }
        }

        if (!achouNossa) rodadas.push({ rodada: numero, estado: 'aguardando' });
    }

    const classificacao = [...tabela.values()]
        .sort((a, b) => b.estrelas - a.estrelas || b.destruicaoTotal - a.destruicaoTotal)
        .map((c, i) => ({
            posicao: i + 1, tag: c.tag, nome: c.nome, estrelas: c.estrelas,
            destruicao: Math.round(c.destruicaoTotal),
            guerras: c.guerras, vitorias: c.vitorias, derrotas: c.derrotas, empates: c.empates,
            nosso: c.nosso
        }));

    const listaJogadores = [...jogadores.values()]
        .map(j => ({
            tag: j.tag, nome: j.nome, cv: j.cv, guerras: j.guerras, ataques: j.ataques,
            estrelas: j.estrelas, faltas: j.faltas,
            destruicao: j.ataques > 0 ? +(j.destruicaoTotal / j.ataques).toFixed(1) : 0
        }))
        .sort((a, b) => b.estrelas - a.estrelas || b.destruicao - a.destruicao || a.faltas - b.faltas);

    // Guerra "atual": a que está valendo agora; senão a próxima; senão a última encerrada.
    const atual =
        guerrasNossas.find(g => g.state === 'inWar') ||
        guerrasNossas.find(g => g.state === 'preparation') ||
        [...guerrasNossas].reverse().find(g => g.state === 'warEnded') ||
        null;

    const nossoClan = (grupo.clans || []).find(c => c.tag === tag);

    for (const r of rodadas) {
        if (!r._lados) continue;
        r.raioX = montarRaioX(r._lados.nos, r._lados.adversario, estat);
        delete r._lados;
    }

    const posicaoPorTag = new Map(classificacao.map(c => [c.tag, c.posicao]));
    const grupoRaioX = (grupo.clans || []).map(c => {
        const cvs = (c.members || []).map(m => m.townHallLevel || m.townhallLevel || 0);
        const e = resumoEstat(estat.get(c.tag));
        return {
            tag: c.tag,
            nome: c.name,
            nosso: c.tag === tag,
            posicao: posicaoPorTag.get(c.tag) ?? null,
            elenco: {
                tamanho: cvs.length,
                cvMedio: cvs.length ? +(cvs.reduce((n, x) => n + x, 0) / cvs.length).toFixed(1) : 0,
                ...distribuicaoCV(cvs)
            },
            taxaTripla: e?.taxaTripla ?? null,
            mediaEstrelas: e?.mediaEstrelas ?? null,
            taxaTriplaSofrida: e?.taxaTriplaSofrida ?? null
        };
    }).sort((a, b) => (a.posicao ?? 99) - (b.posicao ?? 99));

    return {
        emLiga: true,
        cla,
        temporada: grupo.season,
        estado: grupo.state,
        clan: { tag, nome: nossoClan?.name || null },
        totalRodadas: grupo.rounds.length,
        rodadaAtual: atual?.liga?.rodada ?? null,
        rodadas,
        classificacao,
        grupoRaioX,
        jogadores: listaJogadores,
        atualizadoEm: new Date().toISOString(),
        // Uso interno — removidos da resposta pública:
        _guerraAtual: atual,        // rota /guerra-atual
        _guerras: guerrasNossas     // alertas de WhatsApp
    };
}

async function obterLiga(cla) {
    const salvo = cacheLiga.get(cla);
    if (salvo && Date.now() - salvo.em < CACHE_MS) return salvo.dados;

    // Se já tem uma busca rodando pra esse clã, espera ela em vez de disparar outra
    if (emAndamento.has(cla)) return emAndamento.get(cla);

    const promessa = montarLiga(cla)
        .then(dados => {
            cacheLiga.set(cla, { em: Date.now(), dados });
            try { arquivarLiga(dados); } catch (err) { console.error("[LIGA] Arquivo:", err.message); }
            return dados;
        })
        .finally(() => emAndamento.delete(cla));

    emAndamento.set(cla, promessa);
    return promessa;
}

// Guerra atual da Liga no MESMO formato do /currentwar normal.
// Devolve null se o clã não está em Liga. Nunca lança erro.
async function buscarGuerraAtualDaLiga(cla = 'principal') {
    try {
        const liga = await obterLiga(cla);
        return liga.emLiga ? (liga._guerraAtual || null) : null;
    } catch (err) {
        console.error("[LIGA] Falha ao buscar guerra atual da liga:", err.response?.status || err.message);
        return null;
    }
}

// ------------------------------------------------------------
// ALERTAS DA LIGA (só o clã principal, que é o do grupo do WhatsApp)
//   1. Bagre: ataque com 0 ou 1 estrela
//   2. Fim de rodada: faltando 2h ou menos, lista quem não atacou
//
// Cada alerta é gravado no banco antes de ser enviado, então nunca
// sai repetido — nem se o servidor reiniciar no meio da guerra.
// Com simular=true não grava nem envia nada: só devolve o que faria.
// ------------------------------------------------------------
async function jaRegistrado(modelo, idAtaque) {
    return !!(await modelo.findUnique({ where: { idAtaque } }));
}

// Devolve true se gravou agora (ou seja: ainda não tinha sido anunciado)
async function registrarSeNovo(modelo, idAtaque) {
    if (await jaRegistrado(modelo, idAtaque)) return false;
    try {
        await modelo.create({ data: { idAtaque } });
        return true;
    } catch (err) {
        return false;   // outra varredura gravou primeiro
    }
}

async function sincronizarAlertasDaLiga({ simular = false } = {}) {
    const resumo = { emLiga: false, simulacao: simular, primeiraVez: false, bagres: [], avisoFim: null };
    if (!prisma) return resumo;

    const liga = await obterLiga('principal');

    // Na primeira varredura depois de instalar isso, os ataques ruins que JÁ
    // aconteceram são só marcados como vistos, sem mandar mensagem — senão o
    // grupo receberia vários avisos atrasados de uma vez.
    const primeiraVez = !(await jaRegistrado(prisma.ataqueAnunciado, MARCADOR_ALERTAS));
    resumo.primeiraVez = primeiraVez;

    if (liga.emLiga) {
        resumo.emLiga = true;
        const agora = new Date();

        for (const g of liga._guerras || []) {
            const fim = parseDataCoC(g.endTime);
            const acabouAgoraPouco = g.state === 'warEnded' && fim && (agora - fim) < 30 * 60 * 1000;
            if (g.state !== 'inWar' && !acabouAgoraPouco) continue;

            const rodada = g.liga.rodada;
            const membros = g.clan.members || [];

            // ---------- 1. BAGRE ----------
            for (const m of membros) {
                const ataque = (m.attacks || [])[0];
                if (!ataque || ataque.stars > 1) continue;

                const idBagre = `bagre_liga_${g.warTag}_${m.tag}`;
                const item = { nome: m.name, estrelas: ataque.stars, destruicao: ataque.destructionPercentage, rodada };

                if (simular) {
                    if (!(await jaRegistrado(prisma.ataqueBagreAnunciado, idBagre))) {
                        resumo.bagres.push({ ...item, enviaria: !primeiraVez });
                    }
                    continue;
                }

                const novo = await registrarSeNovo(prisma.ataqueBagreAnunciado, idBagre);
                if (!novo) continue;
                resumo.bagres.push({ ...item, enviado: !primeiraVez });
                if (primeiraVez) continue;

                const estrelasTxt = ataque.stars === 1 ? '1 estrela' : '0 estrelas';
                let msg = `🚨 *BAGRE DETECTADO NA LIGA!* 🚨\n\n`;
                msg += `*${m.name}* acabou de atacar com o celular na bunda e fez *${estrelasTxt}* na rodada ${rodada} da Liga!\n`;
                msg += `_(${Number(ataque.destructionPercentage).toFixed(0)}% de destruição)_ 💀😂`;
                await enviarWhatsApp(msg);
            }

            // ---------- 2. FIM DE RODADA ----------
            if (g.state !== 'inWar' || !fim) continue;
            const horas = (fim - agora) / (1000 * 60 * 60);
            if (horas <= 0 || horas > HORAS_AVISO_FIM) continue;

            const pendentes = membros.filter(m => !m.attacks || m.attacks.length === 0);
            if (pendentes.length === 0) continue;

            const idAviso = `aviso_fim_liga_${g.warTag}`;
            const item = { rodada, adversario: g.opponent.name, horasRestantes: +horas.toFixed(2), pendentes: pendentes.map(m => m.name) };

            if (simular) {
                if (!(await jaRegistrado(prisma.ataqueAnunciado, idAviso))) resumo.avisoFim = { ...item, enviaria: true };
                continue;
            }

            if (!(await registrarSeNovo(prisma.ataqueAnunciado, idAviso))) continue;
            resumo.avisoFim = { ...item, enviado: true };

            let msg = `⚠️ *AVISO DE LIGA URGEEEENTE* ⚠️\n`;
            msg += `Faltam menos de *${HORAS_AVISO_FIM} horas* para acabar a rodada ${rodada} da Liga contra *${g.opponent.name}*!\n\n`;
            msg += `Os seguintes membros ainda não atacaram:\n\n`;
            pendentes.forEach(m => { msg += `• *${m.name}*\n`; });
            msg += `\nNa Liga é só 1 ataque. Não prejudique o clã seu Bagre! 🏰⚔️`;
            await enviarWhatsApp(msg);

            if (enviarPush) {
                await enviarPush(
                    '⚠️ Ataques pendentes na Liga!',
                    `Faltam menos de ${HORAS_AVISO_FIM}h! ${pendentes.map(m => m.name).join(', ')} ainda não atacaram.`
                );
            }
        }
    }

    if (primeiraVez && !simular) {
        await registrarSeNovo(prisma.ataqueAnunciado, MARCADOR_ALERTAS);
    }

    return resumo;
}

function registrarRotasLiga(app, opcoes) {
    http = opcoes.axios;
    apiBase = opcoes.apiBase;
    prisma = opcoes.prisma || null;
    enviarWhatsApp = opcoes.enviarMensagemWhatsApp || (async () => { });
    enviarPush = opcoes.enviarNotificacaoPush || null;

    // POST /liga/sincronizar-alertas          → roda a varredura de alertas agora
    // POST /liga/sincronizar-alertas?simular=1 → só mostra o que seria enviado
    if (opcoes.autenticarAdmin) {
        app.post("/liga/sincronizar-alertas", opcoes.autenticarAdmin, async (req, res) => {
            try {
                cacheLiga.delete('principal');   // força buscar dados novos
                const resumo = await sincronizarAlertasDaLiga({ simular: req.query.simular === '1' });
                return res.status(200).json(resumo);
            } catch (err) {
                console.error("[LIGA] Erro nos alertas:", err.response?.status, err.message);
                return res.status(500).json({ erro: "Falha ao sincronizar alertas da liga.", detalhe: err.message });
            }
        });
    }

    // GET /liga/historico → temporadas guardadas (resumo por clã)
    app.get("/liga/historico", (req, res) => {
        const lista = Object.keys(historicoLiga).sort().reverse().map(temporada => ({
            temporada,
            clas: Object.entries(historicoLiga[temporada]).map(([cla, d]) => {
                const nosso = (d.classificacao || []).find(c => c.nosso) || d.resumoTemporada || {};
                return {
                    cla, nome: d.clan?.nome || null, estado: d.estado,
                    rodadasEncerradas: d.rodadasEncerradas, totalRodadas: d.totalRodadas,
                    posicao: nosso.posicao ?? null, vitorias: nosso.vitorias ?? 0,
                    empates: nosso.empates ?? 0, derrotas: nosso.derrotas ?? 0
                };
            })
        }));
        return res.status(200).json(lista);
    });

    // GET /liga/historico/2026-11/principal → a temporada completa daquele clã
    app.get("/liga/historico/:temporada/:cla", (req, res) => {
        const d = historicoLiga[req.params.temporada]?.[req.params.cla];
        if (!d) return res.status(404).json({ erro: "Temporada não encontrada." });
        return res.status(200).json(d);
    });

    // GET /liga/jogador/:tag → desempenho do jogador em cada liga guardada (perfil)
    app.get("/liga/jogador/:tag", (req, res) => {
        let tag = String(req.params.tag || "").trim().toUpperCase();
        if (!tag.startsWith("#")) tag = `#${tag}`;
        const lista = [];
        for (const temporada of Object.keys(historicoLiga).sort().reverse()) {
            for (const [cla, d] of Object.entries(historicoLiga[temporada])) {
                const i = (d.jogadores || []).findIndex(j => j.tag === tag);
                if (i < 0) continue;
                const nosso = (d.classificacao || []).find(c => c.nosso);
                lista.push({
                    temporada, cla, nomeCla: d.clan?.nome || null, estado: d.estado,
                    posicaoNoCla: i + 1, jogadoresNoCla: d.jogadores.length,
                    posicaoDoCla: nosso?.posicao ?? null,
                    ...d.jogadores[i]
                });
            }
        }
        return res.status(200).json(lista);
    });

    // GET /liga/guerras/principal | cla2 | cla3
    app.get("/liga/guerras/:cla", async (req, res) => {
        const { cla } = req.params;
        if (!CLAS_LIGA[cla]) return res.status(400).json({ erro: "Clã inválido. Use principal, cla2 ou cla3." });

        try {
            const { _guerraAtual, _guerras, ...publico } = await obterLiga(cla);
            return res.status(200).json(publico);
        } catch (err) {
            console.error("[LIGA] Erro:", err.response?.status, err.response?.data?.reason || err.message);
            return res.status(500).json({ erro: "Falha ao buscar dados da liga." });
        }
    });
}

module.exports = { registrarRotasLiga, buscarGuerraAtualDaLiga, sincronizarAlertasDaLiga, atualizarHistoricoLiga, parseDataCoC, CLAS_LIGA };
