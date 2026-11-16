// ============================================================
// RECUPERAR GUERRAS QUE FICARAM FORA DO RANKING
// Uso (dentro da pasta back-cla, na VM):
//   node recuperar-guerras.js 2026-10            -> só mostra o que faria
//   node recuperar-guerras.js 2026-10 --aplicar  -> soma no ranking de verdade
//
// Os ataques de cada guerra ficam gravados no banco durante a batalha.
// Se a guerra acabou sem a varredura ver o "encerrada", esses ataques
// nunca entraram no ranking. Este script soma eles agora.
// Limite: quem estava na guerra e não atacou nenhuma vez não aparece nos
// ataques gravados, então essa guerra não conta pra essa pessoa.
// ============================================================
require("dotenv").config();
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const aplicar = process.argv.includes("--aplicar");
const mes = process.argv.find(a => /^\d{4}-\d{2}$/.test(a));

function parseDataCoC(str) {
    if (!str || str.length < 15) return null;
    const d = new Date(`${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}T${str.slice(9, 11)}:${str.slice(11, 13)}:${str.slice(13, 15)}Z`);
    return isNaN(d) ? null : d;
}

(async () => {
    if (!mes) {
        console.log("Informe o mês: node recuperar-guerras.js 2026-10 [--aplicar]");
        process.exit(1);
    }

    // Guerras que já entraram (registradas nas defesas do mês)
    let registradas = new Set();
    try {
        const defesas = JSON.parse(fs.readFileSync("defesas.json", "utf8"));
        registradas = new Set(defesas[mes]?.guerras || []);
    } catch (_) {}

    const ataques = await prisma.ataqueRegistrado.findMany({
        where: { warId: { startsWith: mes.replace("-", "") } }
    });

    const porGuerra = new Map();
    for (const a of ataques) {
        if (!porGuerra.has(a.warId)) porGuerra.set(a.warId, new Map());
        const jogadores = porGuerra.get(a.warId);
        if (!jogadores.has(a.tagJogador)) jogadores.set(a.tagJogador, { estrelas: 0, destruicao: 0, ataques: 0 });
        const j = jogadores.get(a.tagJogador);
        j.estrelas += a.estrelas;
        j.destruicao += a.destruicao;
        j.ataques += 1;
    }

    const DUAS_DIAS = 48 * 60 * 60 * 1000;
    let totalSomados = 0;

    for (const [warId, jogadores] of [...porGuerra].sort()) {
        if (registradas.has(warId)) continue;
        const inicio = parseDataCoC(warId);
        if (inicio && Date.now() - inicio < DUAS_DIAS) {
            console.log(`- ${warId}: guerra ainda em andamento, ignorada.`);
            continue;
        }

        const estrelas = [...jogadores.values()].reduce((n, j) => n + j.estrelas, 0);
        console.log(`\nGuerra ${warId}: ${jogadores.size} jogadores atacaram, ${estrelas} estrelas no total`);

        for (const [tag, j] of jogadores) {
            const membro = await prisma.membro.findUnique({ where: { tag } });
            if (!membro) { console.log(`   ${tag}: não está mais no banco, pulado`); continue; }
            if (membro.guerrasIds?.includes(warId)) { console.log(`   ${membro.nome}: já contava, pulado`); continue; }

            console.log(`   ${membro.nome}: +1 guerra, +${j.estrelas}★, +${Math.round(j.destruicao)}%`);
            if (aplicar) {
                await prisma.membro.update({
                    where: { tag },
                    data: {
                        totalEstrelas: { increment: j.estrelas },
                        totalDestruicao: { increment: Math.round(j.destruicao) },
                        guerras: { increment: 1 },
                        guerrasIds: { push: warId }
                    }
                });
            }
            totalSomados++;
        }
    }

    console.log(aplicar
        ? `\nPronto: ${totalSomados} participação(ões) somadas no ranking.`
        : `\nSimulação: ${totalSomados} participação(ões) seriam somadas. Rode de novo com --aplicar para gravar.`);
    await prisma.$disconnect();
})().catch(async err => {
    console.error("Erro:", err.message);
    await prisma.$disconnect();
    process.exit(1);
});
