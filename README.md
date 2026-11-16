# Clash City BR — API

REST API that powers [Clash City BR](https://github.com/clashcitybr/clashcitybr.github.io): it syncs Clash of Clans war data from the official Supercell API, stores the history in MongoDB and serves rankings, player profiles, league rosters and push notifications to the web app.

> This is the backend. For screenshots, features and the full architecture, see the **[main project README](https://github.com/clashcitybr/clashcitybr.github.io)**.

## Tech stack

- **Node.js + Express**: REST API
- **Prisma ORM + MongoDB Atlas**: main data storage (members, wars, seasons, league rosters)
- **JSON files on disk**: lightweight auxiliary data (push subscriptions, defense stats, usage events, recommended attacks), written atomically through a temp file
- **Supercell Clash of Clans API**: war, member and player data (through a static-IP proxy)
- **web-push (VAPID)**: browser push notifications
- **Baileys**: automated alerts to the clan's WhatsApp group
- **PM2 on a Linux VM**: keeps the service running 24/7

## How it works

1. A scheduled job (every 15 minutes) calls the `/sincronizar-guerra` route, which fetches the current war from the Supercell API.
2. Each attack is stored in MongoDB through Prisma, without duplicates.
3. The frontend (static, on GitHub Pages) calls this API with `fetch` to show rankings, profiles and history.
4. At the end of each month, `/fechar-temporada` archives the season so the new ranking starts empty.
5. Write operations are protected by an Express middleware (`autenticarAdmin`) that checks the `x-admin-key` header against an environment variable.

## Endpoints

🔒 = requires the `x-admin-key` header

**Members and clans**
| Method | Route | Description |
|---|---|---|
| GET | `/membros` | Members with war statistics (monthly ranking) |
| GET | `/membros-cla` | Live member list from Supercell |
| GET | `/membros-familia` | Members across all clans in the family |
| GET | `/clas/resumo` | Summary of each clan |

**Players**
| Method | Route | Description |
|---|---|---|
| GET | `/jogador/:tag` | Player profile (live Supercell data) |
| GET | `/jogador/:tag/guerras` | Player's war attacks |
| GET | `/jogador/:tag/evolucao` | Performance per season (for charts) |
| GET | `/jogador/:tag/conquistas` | Player achievements |
| GET | `/painel/:tag` | Personal dashboard data ("My Dashboard") |

**Wars and seasons**
| Method | Route | Description |
|---|---|---|
| GET | `/guerra-atual` | Current war |
| GET | `/guerras/:cla` | War history of a clan |
| GET | `/defesas` | Defense statistics |
| POST | `/sincronizar-guerra` 🔒 | Syncs the current war from Supercell (called by the scheduler) |
| POST | `/processar-warlog` 🔒 | Processes the war log |
| POST | `/fechar-temporada` 🔒 | Archives the current month |
| GET | `/historico` | List of archived seasons |
| GET | `/historico/:mes` | Ranking of an archived month |
| GET | `/capital/:cla` | Clan Capital data |

**League (CWL)**
| Method | Route | Description |
|---|---|---|
| GET | `/cwl/:cla` | League roster of a clan |
| POST | `/cwl/:cla` 🔒 | Saves the league roster |
| DELETE | `/cwl/:cla` 🔒 | Clears the league roster |

**Recommended attacks**
| Method | Route | Description |
|---|---|---|
| GET | `/ataques` | Recommended armies and hero equipment |
| GET | `/ataques/catalogo` 🔒 | Catalog used by the admin editor |
| POST | `/ataques/exercitos` 🔒 | Adds an army |
| PUT | `/ataques/exercitos/:id` 🔒 | Updates an army |
| DELETE | `/ataques/exercitos/:id` 🔒 | Removes an army |
| PUT | `/ataques/equipamentos` 🔒 | Updates hero equipment |

**Push notifications**
| Method | Route | Description |
|---|---|---|
| GET | `/vapid-public-key` | Public key for the browser subscription |
| POST | `/subscribe` | Subscribes a device |
| POST | `/subscribe/consultar` | Checks a subscription |
| DELETE | `/subscribe` | Removes a subscription |

**Other**
| Method | Route | Description |
|---|---|---|
| POST | `/uso` | Records anonymous usage events |
| GET | `/uso/resumo` 🔒 | Usage summary for the clan leader |
| GET | `/admin/verificar` 🔒 | Validates the admin key |
| GET | `/api/instagram` | Proxy for the clan's Instagram feed |
| DELETE | `/limpar-banco` 🔒 | Resets the monthly ranking to start a new month (after the old one is archived) |

## Running locally

```bash
git clone https://github.com/clashcitybr/clash-city-br-api.git
cd clash-city-br-api
npm install
cp .env.example .env      # fill in your own values
npx prisma generate
node server.js
```

You need:
- a MongoDB Atlas database
- a Clash of Clans API token from [developer.clashofclans.com](https://developer.clashofclans.com)
- a VAPID key pair (`npx web-push generate-vapid-keys`)

On the first run, scan the QR code shown in the terminal to connect WhatsApp. The session is saved locally and is never committed.

## Environment variables

See [`.env.example`](.env.example):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | MongoDB Atlas connection string |
| `CLASH_API_KEY` | Clash of Clans API token |
| `ADMIN_KEY` | Secret for admin routes |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Push notification keys |

## Author

Built by **Carlos Daniel** · [GitHub](https://github.com/CarlosdaniDev) · [LinkedIn](https://www.linkedin.com/in/carlos-daniel-5b49b11b2)
