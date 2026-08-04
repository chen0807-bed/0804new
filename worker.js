const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=900" : "no-store"
    }
  });
}

function clean(value) {
  return String(value ?? "").trim();
}

function decodeHtml(value) {
  return clean(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, "-")
    .replace(/&#8212;/g, "-");
}

function stripTags(value) {
  return decodeHtml(String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "));
}

function num(value) {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fixed(value, digits = 1) {
  const n = num(value);
  return n === null ? "" : n.toFixed(digits);
}

function playerPhotoUrl(playerId) {
  return playerId
    ? `https://img.mlbstatic.com/mlb-photos/image/upload/w_120,q_100/v1/people/${playerId}/headshot/67/current`
    : "";
}

function parseInnings(value) {
  const text = clean(value);
  if (!text) return 0;
  const [wholePart, outsPart = "0"] = text.split(".");
  const whole = Number(wholePart) || 0;
  const outs = Math.min(Number(outsPart) || 0, 2);
  return whole + outs / 3;
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      if (quoted && line[i + 1] === "\"") {
        cell += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }

  cells.push(cell);
  return cells;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map(clean);
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = clean(values[index]);
    });
    return row;
  });
}

function extractCells(rowHtml) {
  return [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map(match => stripTags(match[1]));
}

function extractTables(html) {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(match => {
    const rows = [...match[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(row => extractCells(row[0])).filter(row => row.length);
    return rows;
  });
}

function slugId(url) {
  const match = String(url || "").match(/-(\d{5,})\/?$/);
  return match ? match[1] : "";
}

function normalizeRate(value) {
  const text = clean(value);
  if (!text) return "";
  const n = num(text.replace("%", ""));
  if (n === null) return text;
  return text.includes("%") ? `${n.toFixed(1)}%` : text;
}

function cell(record, names) {
  const lower = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of names) {
    const found = lower[name.toLowerCase()];
    if (found !== undefined) return found;
  }
  return "";
}

async function tjstatsFetch(url) {
  return fetch(url, {
    headers: {
      "accept": "text/html,application/json",
      "user-agent": "Mozilla/5.0 MLB trade value proxy"
    }
  });
}

async function tjstatsSearch(query) {
  const api = new URL("https://tjstats.ca/wp-json/wp/v2/search");
  api.searchParams.set("search", query);
  api.searchParams.set("per_page", "10");

  let results = [];
  const apiResponse = await tjstatsFetch(api.toString());
  if (apiResponse.ok) {
    const payload = await apiResponse.json();
    results = (payload || []).map(item => ({
      title: stripTags(item.title || ""),
      url: item.url || ""
    }));
  }

  if (!results.some(item => item.url.includes("/player/"))) {
    const searchUrl = new URL("https://tjstats.ca/");
    searchUrl.searchParams.set("s", query);
    const htmlResponse = await tjstatsFetch(searchUrl.toString());
    if (htmlResponse.ok) {
      const html = await htmlResponse.text();
      const links = [...html.matchAll(/href=["']([^"']*\/player\/[^"']+)["'][\s\S]*?>([\s\S]*?)<\/a>/gi)]
        .map(match => ({
          title: stripTags(match[2]),
          url: new URL(match[1], "https://tjstats.ca/").toString()
        }));
      results = [...results, ...links];
    }
  }

  const seen = new Set();
  return results
    .filter(item => item.url.includes("/player/"))
    .filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .slice(0, 8);
}

function parseTjstatsPlayer(html, pageUrl, titleFallback) {
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const name = stripTags(titleMatch?.[1] || titleFallback).replace(/\s+-\s+TJStats.*/i, "");
  const playerId = slugId(pageUrl);
  const tables = extractTables(html);

  for (const rows of tables) {
    const headers = rows[0] || [];
    const hasHitting = headers.some(header => ["PA", "HR", "OBP", "SLG", "wOBA", "HardHit%"].includes(header));
    const hasPitching = headers.some(header => ["IP", "ERA", "FIP", "K%", "BB%", "Stuff+"].includes(header));
    if (!hasHitting && !hasPitching) continue;

    const row = rows.find(cells => cells.length === headers.length && cells.some(value => /^\d{4}$/.test(value))) || rows[1];
    if (!row) continue;

    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] || "";
    });

    const obp = cell(record, ["OBP"]);
    const slg = cell(record, ["SLG"]);
    const opsNum = num(obp) !== null && num(slg) !== null ? (num(obp) + num(slg)).toFixed(3) : "";
    const isPitcher = hasPitching && !hasHitting;

    if (isPitcher) {
      return {
        name,
        playerId,
        photoUrl: playerPhotoUrl(playerId),
        sourceLabel: "TJStats 公開資料",
        source: "tjstats",
        type: "pitcher",
        level: "MLB",
        team: "",
        age: "",
        era: cell(record, ["ERA"]),
        fip: cell(record, ["FIP"]),
        ip: cell(record, ["IP"]),
        k9: "",
        bb9: "",
        hr9: "",
        summary: `TJStats ${cell(record, ["Season", "Year"])} / K% ${normalizeRate(cell(record, ["K%"])) || "-"} / BB% ${normalizeRate(cell(record, ["BB%"])) || "-"} / Stuff+ ${cell(record, ["Stuff+"]) || "-"}`
      };
    }

    return {
      name,
      playerId,
      photoUrl: playerPhotoUrl(playerId),
      sourceLabel: "TJStats 公開資料",
      source: "tjstats",
      type: "hitter",
      level: "MLB",
      team: "",
      age: "",
      hr: cell(record, ["HR"]),
      ops: cell(record, ["OPS"]) || opsNum,
      obp,
      slg,
      sb: cell(record, ["SB"]),
      wrcPlus: "",
      summary: `TJStats ${cell(record, ["Season", "Year"])} / PA ${cell(record, ["PA"]) || "-"} / wOBA ${cell(record, ["wOBA"]) || "-"} / HardHit% ${normalizeRate(cell(record, ["HardHit%"])) || "-"}`
    };
  }

  return {
    name,
    playerId,
    photoUrl: playerPhotoUrl(playerId),
    sourceLabel: "TJStats 公開資料",
    source: "tjstats",
    type: "hitter",
    level: "MLB",
    team: "",
    age: "",
    summary: "TJStats 公開頁可讀，但未找到可解析的公開 Season Stats 表格"
  };
}

async function handleTjstats(url) {
  const query = clean(url.searchParams.get("q"));
  if (!query) {
    return json({ error: "請先在搜尋球員欄位輸入 TJStats 球員名稱", rows: [] }, 400);
  }

  const searchResults = await tjstatsSearch(query);
  const rows = [];
  for (const result of searchResults) {
    const response = await tjstatsFetch(result.url);
    if (!response.ok) continue;
    rows.push(parseTjstatsPlayer(await response.text(), result.url, result.title));
  }

  return json({
    source: "TJStats 公開球員頁",
    rows,
    note: "只解析 TJStats 公開可讀球員頁；會員限定頁面不會抓取。"
  });
}

async function handleSavant(url) {
  const start = url.searchParams.get("start") || "2026-07-01";
  const end = url.searchParams.get("end") || "2026-08-02";
  const team = clean(url.searchParams.get("team")).toUpperCase();
  const playerType = url.searchParams.get("playerType") === "pitcher" ? "pitcher" : "batter";

  const source = new URL("https://baseballsavant.mlb.com/statcast_search/csv");
  source.search = "all=true&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7CPO%7CS%7C=&hfSea=&hfSit=&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&position=&hfRO=&home_road=&hfFlag=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=h_launch_speed&sort_order=desc&min_abs=0&type=details&";
  source.searchParams.set("player_type", playerType);
  source.searchParams.set("game_date_gt", start);
  source.searchParams.set("game_date_lt", end);
  if (team) source.searchParams.set("team", team);

  const response = await fetch(source.toString(), {
    headers: {
      "user-agent": "Mozilla/5.0 MLB trade value proxy"
    }
  });

  if (!response.ok) {
    throw new Error(`Baseball Savant responded ${response.status}`);
  }

  const rows = parseCsv(await response.text());
  const groups = new Map();

  rows.forEach(row => {
    const name = clean(row.player_name || row.batter_name || row.pitcher_name || row.name);
    if (!name) return;
    const playerId = clean(playerType === "pitcher" ? row.pitcher : row.batter) || clean(row.player_id || row.mlbam_id);
    const key = playerId || name;
    const group = groups.get(key) || {
      name,
      playerId,
      sourceLabel: "Baseball Savant",
      source: "savant",
      type: playerType === "pitcher" ? "pitcher" : "hitter",
      level: "MLB",
      team,
      events: 0,
      hr: 0,
      evSum: 0,
      evCount: 0,
      xwobaSum: 0,
      xwobaCount: 0,
      veloSum: 0,
      veloCount: 0
    };

    group.events += 1;
    if (row.events === "home_run") group.hr += 1;

    const ev = num(row.launch_speed);
    if (ev !== null) {
      group.evSum += ev;
      group.evCount += 1;
    }

    const xwoba = num(row.estimated_woba_using_speedangle);
    if (xwoba !== null) {
      group.xwobaSum += xwoba;
      group.xwobaCount += 1;
    }

    const velo = num(row.release_speed);
    if (velo !== null) {
      group.veloSum += velo;
      group.veloCount += 1;
    }

    groups.set(key, group);
  });

  const out = Array.from(groups.values())
    .map(row => {
      const avgEv = row.evCount ? row.evSum / row.evCount : null;
      const avgVelo = row.veloCount ? row.veloSum / row.veloCount : null;
      const xwoba = row.xwobaCount ? row.xwobaSum / row.xwobaCount : null;
      const isPitcher = row.type === "pitcher";

      return {
        name: row.name,
        playerId: row.playerId,
        photoUrl: playerPhotoUrl(row.playerId),
        sourceLabel: row.sourceLabel,
        source: row.source,
        type: row.type,
        level: row.level,
        team: row.team,
        age: "",
        hr: isPitcher ? "" : row.hr,
        ops: "",
        obp: "",
        slg: "",
        wrcPlus: "",
        era: "",
        fip: "",
        summary: isPitcher
          ? `Pitches ${row.events} / Avg Velo ${avgVelo === null ? "-" : avgVelo.toFixed(1)}`
          : `BIP ${row.events} / Avg EV ${avgEv === null ? "-" : avgEv.toFixed(1)} / xwOBA ${xwoba === null ? "-" : xwoba.toFixed(3)}`
      };
    })
    .sort((a, b) => Number(b.hr || 0) - Number(a.hr || 0))
    .slice(0, 100);

  return json({ source: "Baseball Savant Statcast", rows: out });
}

async function fetchMlbStats(group, teamId) {
  const endpoint = new URL("https://statsapi.mlb.com/api/v1/stats");
  endpoint.searchParams.set("stats", "season");
  endpoint.searchParams.set("group", group);
  endpoint.searchParams.set("playerPool", "ALL");
  endpoint.searchParams.set("sportIds", "1,11,12,13,14");
  endpoint.searchParams.set("limit", "75");
  endpoint.searchParams.set("hydrate", "team,person");
  endpoint.searchParams.set("sortStat", group === "hitting" ? "ops" : "strikeOuts");
  endpoint.searchParams.set("order", "desc");
  if (teamId) endpoint.searchParams.set("teamId", teamId);

  const response = await fetch(endpoint.toString(), {
    headers: {
      "user-agent": "Mozilla/5.0 MLB trade value proxy"
    }
  });

  if (!response.ok) {
    throw new Error(`MLB Stats API responded ${response.status}`);
  }

  const payload = await response.json();
  return payload?.stats?.[0]?.splits || [];
}

function mlbStatsRow(split, type) {
  const stat = split.stat || {};
  const person = split.player || split.person || {};
  const team = split.team || {};
  const sport = split.sport || {};
  const playerId = clean(person.id || split.playerId);
  const name = clean(person.fullName || person.name || split.player?.fullName);
  if (!name) return null;

  const level = clean(sport.abbreviation || sport.name || team.name || "MiLB");
  const age = clean(person.currentAge || "");

  if (type === "pitcher") {
    const ip = parseInnings(stat.inningsPitched);
    const strikeouts = num(stat.strikeOuts) || 0;
    const walks = num(stat.baseOnBalls) || 0;
    const homers = num(stat.homeRuns) || 0;

    return {
      name,
      playerId,
      photoUrl: playerPhotoUrl(playerId),
      sourceLabel: "MLB/MiLB Stats",
      source: "prospects",
      type: "pitcher",
      level,
      team: clean(team.name),
      age,
      era: clean(stat.era),
      fip: "",
      ip: fixed(stat.inningsPitched, 1),
      k9: ip ? (strikeouts * 9 / ip).toFixed(1) : "",
      bb9: ip ? (walks * 9 / ip).toFixed(1) : "",
      hr9: ip ? (homers * 9 / ip).toFixed(1) : "",
      summary: `IP ${clean(stat.inningsPitched)} / SO ${strikeouts} / WHIP ${clean(stat.whip || "-")}`
    };
  }

  return {
    name,
    playerId,
    photoUrl: playerPhotoUrl(playerId),
    sourceLabel: "MLB/MiLB Stats",
    source: "prospects",
    type: "hitter",
    level,
    team: clean(team.name),
    age,
    hr: clean(stat.homeRuns),
    ops: clean(stat.ops),
    obp: clean(stat.obp),
    slg: clean(stat.slg),
    sb: clean(stat.stolenBases),
    wrcPlus: "",
    summary: `AVG ${clean(stat.avg || "-")} / RBI ${clean(stat.rbi || "-")} / PA ${clean(stat.plateAppearances || "-")}`
  };
}

async function handleProspects(url) {
  const teamId = clean(url.searchParams.get("teamId"));
  const [hitters, pitchers] = await Promise.all([
    fetchMlbStats("hitting", teamId),
    fetchMlbStats("pitching", teamId)
  ]);

  const rows = [
    ...hitters.map(split => mlbStatsRow(split, "hitter")),
    ...pitchers.map(split => mlbStatsRow(split, "pitcher"))
  ].filter(Boolean).slice(0, 120);

  return json({
    source: "MLB/MiLB Prospects & Stats",
    rows
  });
}

async function handlePlayerSearch(url) {
  const query = clean(url.searchParams.get("q"));
  if (!query) return json({ source: "MLB People Search", rows: [] });

  const endpoint = new URL("https://statsapi.mlb.com/api/v1/people/search");
  endpoint.searchParams.set("names", query);
  endpoint.searchParams.set("hydrate", "currentTeam");

  const response = await fetch(endpoint.toString());
  if (!response.ok) {
    throw new Error(`MLB People Search responded ${response.status}`);
  }

  const payload = await response.json();
  const rows = (payload.people || []).slice(0, 50).map(person => ({
    name: clean(person.fullName),
    playerId: clean(person.id),
    photoUrl: playerPhotoUrl(person.id),
    sourceLabel: "MLB People Search",
    source: "people",
    type: clean(person.primaryPosition?.type).toLowerCase().includes("pitcher") ? "pitcher" : "hitter",
    level: "MLB",
    team: clean(person.currentTeam?.name),
    age: clean(person.currentAge),
    summary: clean(person.primaryPosition?.abbreviation || person.primaryPosition?.name || "")
  }));

  return json({ source: "MLB People Search", rows });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/api/health") {
        return json({
          ok: true,
          service: "MLB trade value proxy",
          routes: ["/api/tjstats", "/api/savant", "/api/prospects", "/api/player-search"]
        });
      }
      if (url.pathname === "/api/tjstats") return await handleTjstats(url);
      if (url.pathname === "/api/savant") return await handleSavant(url);
      if (url.pathname === "/api/prospects") return await handleProspects(url);
      if (url.pathname === "/api/player-search") return await handlePlayerSearch(url);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message || "Proxy request failed", rows: [] }, 502);
    }
  }
};
