#!/usr/bin/env python3
# ============================================================
# RECUPERAR AS DEFESAS DE UMA GUERRA PELO HISTÓRICO DO NGROK
#
# O site e o app chamam /guerra-atual a cada poucos minutos e essas
# respostas passam pelo ngrok. O ngrok guarda as últimas requisições na
# memória (painel de inspeção, porta 4040). Se ainda houver uma resposta
# da guerra perdida lá, ela tem TODOS os ataques do inimigo nas nossas
# vilas, e dá pra recontar as defesas.
#
# Uso (na pasta back-cla, na VM):
#   python3 recuperar-defesas-ngrok.py              -> só procura e mostra
#   python3 recuperar-defesas-ngrok.py --aplicar    -> grava em defesas.json
#
# Nada é gravado sem --aplicar. Antes de gravar, faz backup do defesas.json.
# ============================================================
import base64, gzip, json, sys, time, urllib.request, zlib, shutil, os

GUERRA = "20261019T154152.000Z"          # início da preparação da guerra perdida (ARIEL TATUM)
AJUSTE_MANUAL = {"Carlos Daniel": 5}      # defesas já somadas na mão pra essa guerra (são desfeitas antes)
APLICAR = "--aplicar" in sys.argv


def corpo_http(raw_b64):
    raw = base64.b64decode(raw_b64)
    if b"\r\n\r\n" not in raw:
        return None
    cab, corpo = raw.split(b"\r\n\r\n", 1)
    cab = cab.decode("latin-1").lower()
    if "transfer-encoding: chunked" in cab:
        saida, resto = b"", corpo
        while resto:
            linha, _, resto = resto.partition(b"\r\n")
            tam = int(linha.split(b";")[0].strip() or b"0", 16)
            if tam == 0:
                break
            saida += resto[:tam]
            resto = resto[tam + 2:]
        corpo = saida
    if "content-encoding: gzip" in cab:
        corpo = gzip.decompress(corpo)
    elif "content-encoding: deflate" in cab:
        corpo = zlib.decompress(corpo)
    elif "content-encoding: br" in cab:
        return None   # brotli: sem decodificador padrão no Python
    return corpo


def buscar_fotos():
    try:
        with urllib.request.urlopen("http://127.0.0.1:4040/api/requests/http?limit=100000", timeout=60) as r:
            dados = json.load(r)
    except Exception as e:
        print("Não consegui abrir o painel do ngrok (porta 4040):", e)
        return None, []
    reqs = dados.get("requests", [])
    print(f"Painel do ngrok: {len(reqs)} requisições guardadas.")
    if reqs:
        datas = sorted(x.get("start", "") for x in reqs)
        print(f"Período coberto: {datas[0][:19]}  até  {datas[-1][:19]}")

    fotos = []
    for x in reqs:
        uri = (x.get("request") or {}).get("uri", "") or x.get("uri", "")
        if "/guerra-atual" not in uri:
            continue
        resp = x.get("response") or {}
        if not resp.get("raw"):
            continue
        try:
            corpo = corpo_http(resp["raw"])
            g = json.loads(corpo) if corpo else None
        except Exception:
            continue
        if g and g.get("preparationStartTime") == GUERRA:
            total = sum(len(m.get("attacks") or []) for m in (g.get("opponent") or {}).get("members", []))
            fotos.append((total, x.get("start", ""), g))
    return reqs, fotos


def contar_defesas(g):
    nossos = {m["tag"]: m for m in g["clan"]["members"]}
    contra = {}
    for inimigo in g["opponent"]["members"]:
        for a in inimigo.get("attacks") or []:
            if a["defenderTag"] in nossos:
                contra.setdefault(a["defenderTag"], []).append(a)
    resultado = {}
    for tag, lista in contra.items():
        r = {"nome": nossos[tag]["name"], "cv": nossos[tag]["townhallLevel"], "defesas": 0, "estrelasTomadas": 0,
             "destruicaoTomada": 0, "defesasPerfeitas": 0, "seguradas": 0, "estrelasSeguradas": 0,
             "destruicaoSegurada": 0, "seq": []}
        for a in sorted(lista, key=lambda a: a["order"]):
            e, d = a.get("stars", 0), a.get("destructionPercentage", 0)
            r["seq"].append(f"{e}*")
            r["defesas"] += 1
            r["estrelasTomadas"] += e
            r["destruicaoTomada"] += d
            if e >= 3:
                break
            r["seguradas"] += 1
            r["estrelasSeguradas"] += e
            r["destruicaoSegurada"] += d
            if e == 0:
                r["defesasPerfeitas"] += 1
        resultado[tag] = r
    return resultado


reqs, fotos = buscar_fotos()
if reqs is None:
    sys.exit(1)
if not fotos:
    print(f"\nNenhuma resposta da guerra {GUERRA} ainda está no histórico do ngrok. Não dá pra recuperar por aqui.")
    sys.exit(0)

# A foto mais completa = a que tem mais ataques do inimigo
fotos.sort(key=lambda f: (f[0], f[1]))
total, quando, g = fotos[-1]
print(f"\nAchei {len(fotos)} resposta(s) dessa guerra. Usando a mais completa: {quando[:19]}")
print(f"Adversário: {g['opponent']['name']} | estado: {g['state']} | ataques do inimigo registrados: {total}")
if g["state"] != "warEnded":
    print("ATENÇÃO: essa foto é de antes do fim da guerra; ataques feitos depois dela não aparecem.")

with open(f"guerra-{GUERRA[:8]}-recuperada.json", "w") as f:
    json.dump(g, f)
print(f"Cópia completa salva em guerra-{GUERRA[:8]}-recuperada.json\n")

res = contar_defesas(g)
for r in sorted(res.values(), key=lambda r: (-r["seguradas"], r["nome"])):
    print(f"{r['nome']:<22} {r['seguradas']} defesas   ataques: {' '.join(r['seq'])}")
print(f"\nTotal: {sum(r['seguradas'] for r in res.values())} defesas seguradas nessa guerra.")

if not APLICAR:
    print("\nNada foi gravado. Se estiver certo, pare o backend e rode com --aplicar (veja o passo a passo).")
    sys.exit(0)

# ---------- gravar ----------
mes = f"{GUERRA[:4]}-{GUERRA[4:6]}"
backup = f"defesas.backup-{time.strftime('%Y%m%d-%H%M%S')}.json"
shutil.copy("defesas.json", backup)
print(f"\nBackup feito: {backup}")

d = json.load(open("defesas.json"))
doMes = d.setdefault(mes, {"guerras": [], "jogadores": {}})
if GUERRA in doMes["guerras"]:
    print("Essa guerra já está registrada nas defesas. Nada foi alterado.")
    sys.exit(0)

# Desfaz os ajustes manuais feitos pra essa guerra
for tag, j in doMes["jogadores"].items():
    if j.get("nome") in AJUSTE_MANUAL:
        n = AJUSTE_MANUAL[j["nome"]]
        j["seguradas"] = max(0, j.get("seguradas", 0) - n)
        j["defesas"] = max(0, j.get("defesas", 0) - n)
        print(f"Ajuste manual desfeito: {j['nome']} -{n}")

for tag, r in res.items():
    j = doMes["jogadores"].setdefault(tag, {"nome": r["nome"], "cv": r["cv"], "defesas": 0, "estrelasTomadas": 0,
                                            "destruicaoTomada": 0, "defesasPerfeitas": 0, "seguradas": 0,
                                            "estrelasSeguradas": 0, "destruicaoSegurada": 0})
    for campo in ("defesas", "estrelasTomadas", "destruicaoTomada", "defesasPerfeitas",
                  "seguradas", "estrelasSeguradas", "destruicaoSegurada"):
        j[campo] = j.get(campo, 0) + r[campo]
doMes["guerras"].append(GUERRA)

tmp = "defesas.json.tmp"
json.dump(d, open(tmp, "w"))
os.replace(tmp, "defesas.json")
print("Defesas gravadas. Agora inicie o backend de novo (pm2 start clash-backend).")
