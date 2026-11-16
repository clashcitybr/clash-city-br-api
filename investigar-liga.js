// ============================================================
// INVESTIGAR A LIGA PASSADA (ex.: outubro/2026)
//
// Procura em todas as fontes que ainda podem ter dados da liga:
//   1) Painel do ngrok (porta 4040): respostas antigas de /liga/guerras/:cla
//      e /guerra-atual (durante a liga, essa rota devolve a guerra da rodada)
//   2) Banco: IDs dos alertas da liga guardam o "warTag" de cada guerra
//   3) API da Supercell: tenta buscar cada guerra pelo warTag
//
// Uso (na pasta back-cla, na VM):
//   node investigar-liga.js 2026-10            -> SÓ investiga e mostra (não mexe em nada)
//   node investigar-liga.js 2026-10 --aplicar  -> grava no liga-historico.json
//                                                 (pare o backend antes!)
// Tudo que encontrar fica salvo na pasta liga-investigacao/ pra conferência.
// ============================================================
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");

const TEMPORADA = process.argv.find(a => /^\d{4}-\d{2}$/.test(a));
const APLICAR = process.argv.includes("--aplicar");
const API = "https://api.clashofclans.com/v1";
const CLAS = { principal: "#GUPJU0L2", cla2: "#2LQY9RYV0", cla3: "#2JY8QGQC8" };
const PASTA = path.join(__dirname, "liga-investigacao");

if (!TEMPORADA) { console.log("Informe a temporada: node investigar-liga.js 2026-10"); process.exit(1); }
fs.mkdirSync(PASTA, { recursive: true });
const salvar = (nome, dados) => fs.writeFileSync(path.join(PASTA, nome), JSON.stringify(dados, null, 1));
const mesDe = s => (s ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}` : null);

// ---------- 1) ngrok ----------
function getLocal(url) {
    return new Promise((ok, erro) => {
        http.get(url, r => { let b = ""; r.on("data", c => b += c); r.on("end", () => ok(b)); }).on("error", erro);
    });
}
function corpoHttp(rawB64) {
    const raw = Buffer.from(rawB64, "base64");
    const i = raw.indexOf("\r\n\r\n");
    if (i < 0) return null;
    const cab = raw.slice(0, i).toString("latin1").toLowerCase();
    let corpo = raw.slice(i + 4);
    if (cab.includes("transfer-encoding: chunked")) {
        const partes = []; let pos = 0;
        while (pos < corpo.length) {
            const fimLinha = corpo.indexOf("\r\n", pos);
            const tam = parseInt(corpo.slice(pos, fimLinha).toString().split(";")[0], 16);
            if (!tam) break;
            partes.push(corpo.slice(fimLinha + 2, fimLinha + 2 + tam));
            pos = fimLinha + 2 + tam + 2;
        }
        corpo = Buffer.concat(partes);
    }
    if (cab.includes("content-encoding: gzip")) corpo = zlib.gunzipSync(corpo);
    else if (cab.includes("content-encoding: br")) corpo = zlib.brotliDecompressSync(corpo);
    else if (cab.includes("content-encoding: deflate")) corpo = zlib.inflateSync(corpo);
    return corpo.toString("utf8");
}

async function investigarNgrok(achados) {
    let reqs;
    try {
        // Mais leve: se já existir uma cópia do painel salva em arquivo, usa ela
        const arqNgrok = (process.argv.find(a => a.startsWith("--ngrok=")) || "").slice(8);
        const texto = arqNgrok ? fs.readFileSync(arqNgrok, "utf8")
                               : await getLocal("http://127.0.0.1:4040/api/requests/http?limit=100000");
        console.log(`ngrok: ${(texto.length / 1048576).toFixed(0)} MB lidos, analisando...`);
        reqs = JSON.parse(texto).requests || [];
    } catch (e) {
        console.log("ngrok: painel indisponível (" + e.message + ")");
        return;
    }
    const datas = reqs.map(r => r.start || "").filter(Boolean).sort();
    console.log(`ngrok: ${reqs.length} requisições guardadas, de ${datas[0]?.slice(0, 16)} até ${datas[datas.length - 1]?.slice(0, 16)}`);

    const diag = { liga: 0, ligaStatus: {}, ligaTemporadas: {}, guerraLiga: {} };
    for (const r of reqs) {
        const uri = r.request?.uri || r.uri || "";
        if (/\/liga\/guerras\//.test(uri)) {
            diag.liga++;
            const st = r.response?.status_code || r.response?.status || "?";
            diag.ligaStatus[st] = (diag.ligaStatus[st] || 0) + 1;
        }
        if (!r.response?.raw) continue;
        const ehLiga = uri.match(/\/liga\/guerras\/(principal|cla2|cla3)/);
        const ehGuerra = uri.includes("/guerra-atual");
        if (!ehLiga && !ehGuerra) continue;
        let d;
        try { d = JSON.parse(corpoHttp(r.response.raw)); } catch (_) { continue; }

        if (ehLiga) diag.ligaTemporadas[`${d?.emLiga ? d.temporada : "fora da liga"}`] = (diag.ligaTemporadas[`${d?.emLiga ? d.temporada : "fora da liga"}`] || 0) + 1;
        if (ehGuerra && d?.liga && d.warTag) diag.guerraLiga[d.warTag] = `${d.state} ${String(d.startTime).slice(0, 8)} vs ${d.opponent?.name}`;
        if (ehLiga && d?.emLiga && d.temporada === TEMPORADA) {
            const cla = ehLiga[1];
            const encerradas = (d.rodadas || []).filter(x => x.estado === "warEnded").length;
            const atual = achados.snapshots[cla];
            if (!atual || encerradas > atual.encerradas || (encerradas === atual.encerradas && r.start > atual.quando)) {
                achados.snapshots[cla] = { encerradas, quando: r.start, dados: d };
            }
        }
        if (ehGuerra && d?.liga && d.warTag && mesDe(d.startTime || d.preparationStartTime) === TEMPORADA) {
            const atual = achados.guerras[d.warTag];
            const ataques = (d.clan?.members || []).reduce((n, m) => n + (m.attacks?.length || 0), 0);
            if (!atual || ataques >= atual.ataques) achados.guerras[d.warTag] = { ataques, fonte: "ngrok", guerra: d, cla: d.liga.cla };
        }
    }
    console.log(`ngrok · chamadas da página da Liga: ${diag.liga} | status: ${JSON.stringify(diag.ligaStatus)} | temporadas lidas: ${JSON.stringify(diag.ligaTemporadas)}`);
    console.log(`ngrok · guerras da liga vistas na home: ${Object.keys(diag.guerraLiga).length}`);
    for (const [t, txt] of Object.entries(diag.guerraLiga)) console.log(`   ${t}: ${txt}`);
}

// ---------- 2) banco ----------
async function investigarBanco(achados) {
    const prisma = new PrismaClient();
    try {
        const ids = [
            ...(await prisma.ataqueAnunciado.findMany({ where: { idAtaque: { contains: "liga_" } } })).map(x => x.idAtaque),
            ...(await prisma.ataqueBagreAnunciado.findMany({ where: { idAtaque: { contains: "liga_" } } })).map(x => x.idAtaque)
        ];
        for (const id of ids) {
            const m = id.match(/liga_(#[0-9A-Z]+)/);
            if (m) achados.warTagsBanco.add(m[1]);
        }
        console.log(`Banco: ${ids.length} alertas da liga, ${achados.warTagsBanco.size} warTag(s) diferentes.`);
    } catch (e) {
        console.log("Banco: falha ao ler (" + e.message + ")");
    } finally {
        await prisma.$disconnect();
    }
}

// ---------- 3) Supercell pelo warTag ----------
async function investigarApi(achados) {
    const headers = { Authorization: `Bearer ${process.env.CLASH_API_KEY}`, Accept: "application/json" };
    const tags = new Set([...achados.warTagsBanco, ...Object.keys(achados.guerras)]);
    for (const tag of tags) {
        try {
            const g = (await axios.get(`${API}/clanwarleagues/wars/${encodeURIComponent(tag)}`, { headers })).data;
            if (mesDe(g.startTime || g.preparationStartTime) !== TEMPORADA) { console.log(`API ${tag}: guerra de outra temporada`); continue; }
            const cla = Object.entries(CLAS).find(([, t]) => g.clan?.tag === t || g.opponent?.tag === t)?.[0];
            if (!cla) continue;
            const nos = g.clan.tag === CLAS[cla] ? g.clan : g.opponent;
            const adv = g.clan.tag === CLAS[cla] ? g.opponent : g.clan;
            const ataques = (nos.members || []).reduce((n, m) => n + (m.attacks?.length || 0), 0);
            const atual = achados.guerras[tag];
            if (!atual || g.state === "warEnded" || ataques >= atual.ataques) {
                achados.guerras[tag] = { ataques, fonte: "api", cla, guerra: { ...g, clan: nos, opponent: adv, warTag: tag } };
            }
            console.log(`API ${tag}: ✅ disponível (${cla}, ${g.state}, vs ${adv.name})`);
        } catch (e) {
            console.log(`API ${tag}: ❌ ${e.response?.status || e.message}`);
        }
        await new Promise(r => setTimeout(r, 150));
    }
}

// ---------- monta a temporada a partir das guerras (quando não há foto do ngrok) ----------
function resultadoDe(a, b) {
    if (a.stars !== b.stars) return a.stars > b.stars ? "vitoria" : "derrota";
    if (a.destructionPercentage !== b.destructionPercentage) return a.destructionPercentage > b.destructionPercentage ? "vitoria" : "derrota";
    return "empate";
}
function montarDeGuerras(cla, lista) {
    lista.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    // Rodadas da liga são diárias: numera pela distância em dias da 1ª guerra encontrada.
    // Se a 1ª e a última estão a 6 dias, a 1ª encontrada é com certeza a rodada 1.
    const dia = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 86400000;
    const d0 = dia(lista[0].startTime), dN = dia(lista[lista.length - 1].startTime);
    // --primeira-rodada=3 → a 1ª guerra encontrada é a rodada 3 (as anteriores se perderam)
    const primeira = parseInt((process.argv.find(a => a.startsWith("--primeira-rodada=")) || "").split("=")[1], 10) || 1;
    if (dN - d0 < 6 && primeira === 1) console.log(`(${cla}: guerras encontradas cobrem só ${dN - d0 + 1} dias; numeração das rodadas é aproximada)`);
    const jog = new Map();
    const rodadas = lista.map((g, i) => {
        for (const m of g.clan.members || []) {
            const j = jog.get(m.tag) || { tag: m.tag, nome: m.name, cv: m.townhallLevel, guerras: 0, ataques: 0, estrelas: 0, destruicaoTotal: 0, faltas: 0 };
            j.guerras++;
            const a = (m.attacks || [])[0];
            if (a) { j.ataques++; j.estrelas += a.stars; j.destruicaoTotal += a.destructionPercentage; }
            else if (g.state === "warEnded") j.faltas++;
            jog.set(m.tag, j);
        }
        const lado = x => ({ tag: x.tag, nome: x.name, estrelas: x.stars ?? 0, destruicao: +(x.destructionPercentage ?? 0).toFixed(1), ataques: x.attacks ?? 0 });
        return { rodada: dia(g.startTime) - d0 + primeira, estado: g.state, inicio: g.startTime, fim: g.endTime, tamanho: g.teamSize,
                 nos: lado(g.clan), adversario: lado(g.opponent), resultado: g.state === "warEnded" ? resultadoDe(g.clan, g.opponent) : null, pendentes: [] };
    });
    const jogadores = [...jog.values()].map(j => ({ tag: j.tag, nome: j.nome, cv: j.cv, guerras: j.guerras, ataques: j.ataques,
        estrelas: j.estrelas, faltas: j.faltas, destruicao: j.ataques ? +(j.destruicaoTotal / j.ataques).toFixed(1) : 0 }))
        .sort((a, b) => b.estrelas - a.estrelas || b.destruicao - a.destruicao || a.faltas - b.faltas);
    const faltando = [];
    for (let n = 1; n <= 7; n++) if (!rodadas.some(r => r.rodada === n)) faltando.push(n);
    for (const n of faltando) rodadas.push({ rodada: n, estado: "naoRecuperada" });
    rodadas.sort((a, b) => a.rodada - b.rodada);
    // --resumo=354,6,0,1 → estrelas do clã na temporada (registro de guerra), vitórias, empates, derrotas
    const r = ((process.argv.find(a => a.startsWith("--resumo=")) || "").split("=")[1] || "").split(",").map(Number);
    const resumoTemporada = r.length === 4 && r.every(n => !isNaN(n))
        ? { estrelas: r[0], vitorias: r[1], empates: r[2], derrotas: r[3] } : null;
    const observacao = faltando.length
        ? `Temporada recuperada depois que acabou: ${faltando.length === 1 ? "a rodada" : "as rodadas"} ${faltando.join(" e ")} não ${faltando.length === 1 ? "pôde" : "puderam"} ser recuperada${faltando.length === 1 ? "" : "s"}, e a classificação do grupo não está disponível.`
        : "Temporada recuperada depois que acabou: a classificação do grupo não está disponível.";
    return { emLiga: true, cla, temporada: TEMPORADA, estado: "ended", clan: { tag: CLAS[cla], nome: lista[0]?.clan?.name || null },
             totalRodadas: 7, rodadaAtual: null, rodadas, classificacao: [], jogadores, parcial: true, observacao, resumoTemporada };
}

(async () => {
    console.log(`\n===== Investigando a liga ${TEMPORADA} =====\n`);
    const achados = { snapshots: {}, guerras: {}, warTagsBanco: new Set() };
    if (process.argv.includes("--sem-ngrok")) console.log("ngrok: pulado (--sem-ngrok)");
    else await investigarNgrok(achados);
    // warTags já achados nas rodadas anteriores (salvos na pasta da investigação)
    try {
        const antes = JSON.parse(fs.readFileSync(path.join(PASTA, `guerras-${TEMPORADA}.json`), "utf8"));
        for (const t of Object.keys(antes)) achados.warTagsBanco.add(t);
    } catch (_) {}
    // warTags passados na mão: --tags=#AAA,#BBB
    const extras = (process.argv.find(a => a.startsWith("--tags=")) || "").slice(7);
    for (const t of extras.split(",").map(x => x.trim().toUpperCase()).filter(Boolean)) achados.warTagsBanco.add(t.startsWith("#") ? t : `#${t}`);
    await investigarBanco(achados);
    await investigarApi(achados);

    console.log("\n===== RESULTADO =====");
    const final = {};
    for (const cla of Object.keys(CLAS)) {
        const snap = achados.snapshots[cla];
        const guerras = Object.values(achados.guerras).filter(g => g.cla === cla).map(g => g.guerra);
        if (snap) {
            final[cla] = { ...snap.dados, rodadasEncerradas: snap.encerradas, recuperadoDe: `ngrok ${snap.quando}` };
            console.log(`${cla}: ✅ temporada COMPLETA pelo ngrok (${snap.encerradas} rodadas encerradas, foto de ${snap.quando?.slice(0, 16)})`);
        } else if (guerras.length) {
            const d = montarDeGuerras(cla, guerras);
            final[cla] = { ...d, rodadasEncerradas: d.rodadas.filter(r => r.estado === "warEnded").length, recuperadoDe: "guerras avulsas" };
            console.log(`${cla}: ⚠️ PARCIAL: ${guerras.length} guerra(s) de 7 (sem classificação do grupo)`);
        } else {
            console.log(`${cla}: ❌ nada encontrado`);
        }
    }
    salvar(`resultado-${TEMPORADA}.json`, final);
    salvar(`guerras-${TEMPORADA}.json`, achados.guerras);
    console.log(`\nTudo que achei está em liga-investigacao/ (nada do backend foi alterado).`);

    for (const [cla, d] of Object.entries(final)) {
        console.log(`\n--- ${cla} · top 5 da liga ---`);
        (d.jogadores || []).slice(0, 5).forEach((j, i) => console.log(`${i + 1}. ${j.nome}: ${j.estrelas}★ em ${j.ataques}/${j.guerras} ataques`));
    }

    if (!APLICAR) { console.log("\nSe estiver certo: pare o backend e rode de novo com --aplicar."); return; }
    if (!Object.keys(final).length) { console.log("\nNada para gravar."); return; }

    const arq = path.join(__dirname, "liga-historico.json");
    let hist = {};
    try { hist = JSON.parse(fs.readFileSync(arq, "utf8")); } catch (_) {}
    if (fs.existsSync(arq)) fs.copyFileSync(arq, path.join(PASTA, `liga-historico.backup-${Date.now()}.json`));
    hist[TEMPORADA] = { ...(hist[TEMPORADA] || {}) };
    for (const [cla, d] of Object.entries(final)) {
        const ja = hist[TEMPORADA][cla];
        if (ja && !ja.parcial && d.parcial) { console.log(`${cla}: já existe versão completa, mantida.`); continue; }
        const { _guerraAtual, _guerras, ...publico } = d;
        hist[TEMPORADA][cla] = { ...publico, arquivadoEm: new Date().toISOString() };
        console.log(`${cla}: gravado no histórico.`);
    }
    fs.writeFileSync(arq + ".tmp", JSON.stringify(hist));
    fs.renameSync(arq + ".tmp", arq);
    console.log("\nPronto. Agora: pm2 start clash-backend");
})().catch(e => { console.error("Erro:", e.message); process.exit(1); });
