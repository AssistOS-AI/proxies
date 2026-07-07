# SearchAgent Architecture

## Rolul agentului

SearchAgent este un agent Ploinky care expune un API HTTP simplu pentru web search.

Scopul lui este sa ascunda diferentele dintre providerii de search si sa ofere consumatorilor un raspuns standard:

```json
{
  "results": [
    {
      "title": "Result title",
      "url": "https://example.com",
      "snippet": "Short result text"
    }
  ]
}
```

Providerii pot intoarce campuri diferite, dar SearchAgent normalizeaza rezultatele la `title`, `url` si `snippet`. Campurile extra venite de la provider sunt pastrate in obiectul rezultat atunci cand exista.

Agentul este folosit de GPTResearcher pentru web search. GPTResearcher trimite catre SearchAgent providerul selectat si query-ul generat in pipeline-ul sau de research.

## Componente

SearchAgent ruleaza un server HTTP custom Node.js pornit de:

```text
/code/startup.sh
```

Startup-ul executa:

```text
node /code/src/server.mjs
```

Agentul nu foloseste AgentServer si nu expune tool-uri MCP. Suprafata lui principala este HTTP prin routerul Ploinky.

## API HTTP

Endpointurile principale sunt:

- `GET /healthz`: readiness simplu.
- `GET /listProviders`: lista providerilor disponibili si starea lor de configurare.
- `GET /settings`: citeste setarile SearchAgent.
- `POST /settings`: salveaza setarile SearchAgent.
- `POST /search`: executa o cautare.

Prin Ploinky, aceste endpointuri sunt expuse sub serviciul:

```text
/services/search-agent/
```

`/search` primeste:

```json
{
  "provider": "duckduckgo",
  "query": "search query",
  "maxResults": 5
}
```

`provider` si `query` sunt obligatorii. `maxResults` este optional si este limitat de setarea `maxResults`.

Raspunsul de succes nu contine `ok`, `provider` sau `query`; contine doar rezultatele normalizate:

```json
{
  "results": []
}
```

Erorile sunt intoarse cu obiect `error` si `results: []`.

## Setari persistente

Setarile agentului sunt salvate intr-un singur fisier JSON:

```text
$HOME/search-agent-settings.json
```

In container, `$HOME` este root-ul persistent al agentului (`/root`). In Ploinky, acest root este mapat pe host in:

```text
.data/searchAgent
```

Deci fisierul de settings apare pe host ca:

```text
.data/searchAgent/search-agent-settings.json
```

Fisierul contine doar setari non-secret:

```json
{
  "maxResults": 20,
  "maxQueryChars": 4000
}
```

Daca fisierul lipseste, codul foloseste aceste valori default.

`maxResults` este normalizat intre `1` si `100`. `maxQueryChars` este normalizat intre `1` si `20000`.

Cheile providerilor de search nu sunt salvate in settings.

## Settings UI

Modalul de settings din IDE este implementat de pluginul:

```text
IDE-plugins/search-agent-settings
```

Pluginul nu foloseste MCP. El citeste si salveaza setarile prin endpointul HTTP:

```text
/services/search-agent/settings
```

In UI se pot seta:

- `maxResults`: limita maxima pentru rezultatele cerute unui provider.
- `maxQueryChars`: limita maxima pentru query-ul primit de `/search`.

## Provideri de search

Providerii sunt inregistrati in `src/providers/index.mjs`.

Providerii curenti sunt:

- `duckduckgo`
- `tavily`
- `brave`
- `exa`
- `serper`
- `searxng`
- `jina`

`/listProviders` intoarce pentru fiecare provider:

```json
{
  "provider": "tavily",
  "name": "Tavily",
  "requiredEnv": [
    { "name": "TAVILY_API_KEY", "configured": true }
  ]
}
```

`requiredEnv` include variabilele de environment obligatorii pentru provider si statusul fiecareia. Daca un provider nu are cheile necesare, ramane listat, dar cautarea prin el intoarce eroare `PROVIDER_NOT_CONFIGURED`.

## Configurarea providerilor

Cheile si URL-urile providerilor sunt citite doar din environment-ul SearchAgent.

Variabilele folosite sunt:

- `TAVILY_API_KEY`
- `BRAVE_API_KEY`
- `EXA_API_KEY`
- `SERPER_API_KEY`
- `JINA_API_KEY`
- `SEARXNG_URL`

`duckduckgo` nu cere cheie. `jina` poate functiona fara cheie, dar foloseste `JINA_API_KEY` daca este setata.

Setarile din UI nu contin chei API si nu modifica providerii disponibili.

## Normalizarea rezultatelor

Fiecare provider apeleaza API-ul lui nativ si intoarce lista de rezultate in formatul propriu.

SearchAgent normalizeaza fiecare rezultat prin `normalizeResults`:

- `title` vine din campuri precum `title` sau `name`.
- `url` vine din campuri precum `url`, `link` sau `href`.
- `snippet` vine din campuri precum `snippet`, `content`, `description`, `body` sau `text`.

Rezultatele fara URL sunt ignorate. Rezultatele duplicate dupa URL sunt eliminate. Lista este taiata la `maxResults`.

Rezultatul normalizat pastreaza si campurile originale ale providerului, astfel incat un consumator poate folosi informatii extra daca exista.

## Flow-ul unei cautari

Pentru `POST /search`, serverul:

1. Citeste setarile persistente din `$HOME/search-agent-settings.json`.
2. Valideaza `provider` si `query`.
3. Verifica limita `maxQueryChars`.
4. Calculeaza `maxResults` din request si settings.
5. Alege providerul cerut.
6. Apeleaza providerul cu `query` si `maxResults`.
7. Intoarce `{ results }`.

SearchAgent nu rescrie semantic query-ul. Providerii pot avea ajustari locale necesare pentru API-ul lor. De exemplu, Tavily limiteaza query-ul trimis catre API la 400 de caractere, deoarece providerul are aceasta limita.

## Logging si erori

Serverul scrie loguri JSON pe stdout/stderr pentru fiecare request important.

Pentru `/search`, logul include:

- providerul cerut;
- numarul de caractere al query-ului;
- query-ul, taiat la 2000 de caractere in log;
- `maxResults` cerut;
- numarul de rezultate sau eroarea.

Erorile de provider HTTP sunt intoarse ca `PROVIDER_HTTP_ERROR`, de obicei cu status HTTP `502`. Cand providerul ofera detalii utile, SearchAgent include un preview scurt in `error.details`.

## Date persistente

Agentul foloseste `$HOME` pentru datele persistente proprii:

```text
$HOME/search-agent-settings.json
```

Pe host, acest fisier este in:

```text
.data/searchAgent/search-agent-settings.json
```

SearchAgent nu salveaza rezultate de search si nu pastreaza cache de cautari.

## Reguli operationale

Consumatorii trebuie sa aleaga explicit providerul in requestul `/search`.

Setarile `maxResults` si `maxQueryChars` trebuie schimbate prin modalul IDE sau prin endpointul `/settings`, nu prin variabile de environment.

Cheile API ale providerilor trebuie configurate prin environment-ul agentului, nu prin settings.

Raspunsul standard pentru search trebuie sa ramana `{ results: [...] }`, cu fiecare rezultat avand cel putin `title`, `url` si `snippet`.
