import * as cheerio from "cheerio";
import axios from "axios";
import { AnimeMedia } from "../../../../types/anime";
import { Episode } from "../../../../types/episode";
import CryptoJS from 'crypto-js';

import {
  ResultSearch,
  AnimeResult
} from "../../../../types/search";
import { AnimeScraperModel } from "../../../../models/AnimeScraperModel";

// ============================================================
// Configuración de Byparr
// ============================================================
const BYPARR_URL = "https://byparr.rep4ir.dpdns.org/v1";

async function fetchHtmlViaByparr(targetUrl: string): Promise<string> {
  try {
    const response = await axios.post(
      BYPARR_URL,
      {
        cmd: "request.get",
        url: targetUrl,
        max_timeout: 90,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        timeout: 100000,
      }
    );

    const solution = response.data?.solution;

    if (!solution || solution.status !== 200) {
      throw new Error(
        `Byparr no pudo resolver la URL: ${targetUrl}. ` +
        `Status: ${solution?.status}, Mensaje: ${solution?.message || 'desconocido'}`
      );
    }

    if (!solution.response) {
      throw new Error(`Byparr devolvió una respuesta vacía para: ${targetUrl}`);
    }

    return solution.response as string;
  } catch (error) {
    console.error(`[AnimeLatinoHD] Error en Byparr para ${targetUrl}:`, error);
    throw error;
  }
}

// ============================================================
// Parser del stream Flight de Next.js App Router
// ============================================================

function concatFlightData(html: string): string {
  const chunks: string[] = [];
  const regex = /self\.__next_f\.push\(\[\d+,"((?:[^"\\]|\\.)*)"\]\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    chunks.push(match[1]);
  }
  return chunks.join("");
}

/**
 * Extrae el primer objeto JSON balanceado que comienza en la
 * posición dada, teniendo en cuenta los escapes del flight.
 */
function extractBalancedObject(
  str: string,
  startIdx: number
): { escaped: string; end: number } | null {
  let depth = 0;
  let end = -1;
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') {
      i++; // saltar el carácter escapado
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  return { escaped: str.slice(startIdx, end), end };
}

/**
 * Desescapa un fragmento del flight y lo parsea como JSON.
 */
function parseEscapedJson(escaped: string): any {
  const json = escaped.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return JSON.parse(json);
}

/**
 * Busca un objeto JSON por sus marcadores de apertura (en formato
 * escapado y sin escapar) y devuelve el objeto resultante.
 */
function findByMarkers(flight: string, markers: string[]): any | null {
  for (const marker of markers) {
    const idx = flight.indexOf(marker);
    if (idx === -1) continue;

    const extracted = extractBalancedObject(flight, idx);
    if (!extracted) continue;

    try {
      return parseEscapedJson(extracted.escaped);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Devuelve el payload del anime.
 *
 * Estructura esperada (observada en el diagnóstico):
 *   {\"data\":{\"anime\":{\"id\":...,\"name\":...,\"episodes\":[...]}}}
 *
 * También contempla el caso de que vuelvan a cifrar los datos
 * (campo base64 con firma Laravel iv/value/mac).
 */
function extractAnimePayload(
  flight: string
): { type: 'plain'; value: any } | { type: 'encrypted'; value: string } {
  // 1. Buscar objeto {\"data\":{\"anime\":...}}
  const animeMarkers = [
    '{\\"data\\":{\\"anime\\":',
    '{"data":{"anime":',
    '{\\"anime\\":',
    '{"anime":',
  ];
  const animeObj = findByMarkers(flight, animeMarkers);
  if (animeObj) {
    // Puede venir como {"data":{"anime":{...}}} o directamente {"anime":{...}}
    const anime = animeObj?.data?.anime ?? animeObj?.data ?? animeObj?.anime ?? animeObj;
    return { type: 'plain', value: anime };
  }

  // 2. Fallback: buscar cualquier objeto que contenga "episodes"
  const epMarkers = ['\\"episodes\\":', '"episodes":'];
  for (const marker of epMarkers) {
    const idx = flight.indexOf(marker);
    if (idx === -1) continue;

    // Retroceder hasta la { que abre el objeto padre
    let depth = 0;
    let start = -1;
    for (let i = idx; i >= 0; i--) {
      const ch = flight[i];
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) { start = i; break; }
        depth--;
      }
    }
    if (start === -1) continue;

    const extracted = extractBalancedObject(flight, start);
    if (!extracted) continue;

    try {
      const obj = parseEscapedJson(extracted.escaped);
      return { type: 'plain', value: obj };
    } catch {
      continue;
    }
  }

  // 3. Último recurso: cifrado Laravel (por si el sitio vuelve a cifrar)
  const b64Regex = /\\"([a-zA-Z_][a-zA-Z0-9_]*)\\":\\"([A-Za-z0-9+/=]{40,})\\"/g;
  let m: RegExpExecArray | null;
  while ((m = b64Regex.exec(flight)) !== null) {
    try {
      const decoded = Buffer.from(m[2], 'base64').toString('utf-8');
      if (
        decoded.startsWith('{') &&
        decoded.includes('"iv"') &&
        decoded.includes('"value"') &&
        decoded.includes('"mac"')
      ) {
        return { type: 'encrypted', value: m[2] };
      }
    } catch {
      // ignorar
    }
  }

  throw new Error(
    `No se encontró el objeto del anime en el Flight. ` +
    `Longitud: ${flight.length}. ` +
    `Primeros 500: ${flight.substring(0, 500)}`
  );
}

// ============================================================

export class AnimeLatinoHD extends AnimeScraperModel {

  readonly url = "https://www.animelatinohd.com";
  readonly api = "https://web.animelatinohd.com";
  readonly key = "l7z8rIhQDXIH6pl66ZEQgPkNwkDlilgdOHMMWkxkzzE=";

  async GetItemInfo(anime: string): Promise<AnimeMedia> {
    try {
      const html = await fetchHtmlViaByparr(`${this.url}/anime/${anime}`);
      const flight = concatFlightData(html);

      const payload = extractAnimePayload(flight);

      const animeInfoParseObj =
        payload.type === 'encrypted'
          ? JSON.parse(this.decrypt(payload.value))
          : payload.value;

      const AnimeInfo: AnimeMedia = {
        name: animeInfoParseObj.name,
        url: `/anime/animelatinohd/name/${anime}`,
        synopsis: animeInfoParseObj.overview,
        alt_names: animeInfoParseObj.name_alternative
          ? animeInfoParseObj.name_alternative.split(",")
          : [],
        image: {
          url:
            "https://www.themoviedb.org/t/p/original" +
            animeInfoParseObj.poster +
            "?&w=53&q=95",
        },
        genres: animeInfoParseObj.genres
          ? animeInfoParseObj.genres.split(",")
          : [],
        type: animeInfoParseObj.type,
        status: animeInfoParseObj.status == 1 ? "En emisión" : "Finalizado",
        date: animeInfoParseObj.aired,
        episodes: [],
      };

      (animeInfoParseObj.episodes || []).forEach((e: any) => {
        AnimeInfo.episodes.push({
          name: animeInfoParseObj.name,
          num: Number(e.number),
          thumbnail: {
            url:
              "https://www.themoviedb.org/t/p/original" +
              animeInfoParseObj.banner +
              "?&w=280&q=95",
          },
          url: `/anime/animelatinohd/episode/${
            animeInfoParseObj.slug + "-" + e.number
          }`,
        });
      });

      return AnimeInfo;
    } catch (error) {
      console.error("[AnimeLatinoHD] GetItemInfo error:", error);
      return {
        name: "",
        url: "",
        synopsis: "",
        alt_names: [],
        image: { url: "" },
        genres: [],
        episodes: [],
      };
    }
  }

  async GetEpisodeServers(episode: string, lang: string): Promise<Episode> {
    try {
      const number = episode.substring(episode.lastIndexOf("-") + 1);
      const anime = episode.substring(0, episode.lastIndexOf("-"));
      const langType = [
        { lang: "es", type: "Latino" },
        { lang: "jp", type: "Subtitulado" },
      ];

      const html = await fetchHtmlViaByparr(`${this.url}/ver/${anime}/${number}`);
      const flight = concatFlightData(html);

      const payload = extractAnimePayload(flight);

      const animeEpisodeParseObj =
        payload.type === 'encrypted'
          ? JSON.parse(this.decrypt(payload.value))
          : payload.value;

      const AnimeEpisodeInfo: Episode = {
        name: animeEpisodeParseObj.anime?.name || animeEpisodeParseObj.name || "",
        url: `/anime/animelatinohd/episode/${episode}`,
        num: Number(number),
        servers: [],
      };

      const $ = cheerio.load(html);

      const sel_lang = langType.filter((e) => e.lang == lang);
      let f_index = 0;

      if (sel_lang.length) {
        let found = false;
        $("#languaje option").each((_i, e) => {
          if ($(e).text() == sel_lang[0].type) {
            f_index = Number($(e).val());
            found = true;
            return false;
          }
        });
        if (!found) {
          const firstVal = $("#languaje option").first().val();
          f_index = firstVal ? Number(firstVal) : 0;
        }
      } else {
        const firstVal = $("#languaje option").first().val();
        f_index = firstVal ? Number(firstVal) : 0;
      }

      const players = animeEpisodeParseObj.players?.[f_index] || [];
      for (let index = 0; index < players.length; index++) {
        AnimeEpisodeInfo.servers.push({
          name: players[index].server.title,
          url: `${this.api}/video/${this.encrypt(
            JSON.stringify(players[index].id)
          )}`,
        });
      }

      AnimeEpisodeInfo.servers.sort((a, b) => a.name.localeCompare(b.name));
      return AnimeEpisodeInfo;
    } catch (error) {
      console.error("[AnimeLatinoHD] GetEpisodeServers error:", error);
      return {
        name: "",
        url: "",
        num: 0,
        servers: [],
      };
    }
  }

  decrypt(data: string) {
    let t = CryptoJS.enc.Base64.parse(data).toString(CryptoJS.enc.Utf8);
    t = JSON.parse(t);
    const a = CryptoJS.enc.Base64.parse(t.iv);
    const n = CryptoJS.AES.decrypt(t.value, CryptoJS.enc.Base64.parse(this.key), {
      iv: a,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    return CryptoJS.enc.Utf8.stringify(n);
  }

  encrypt(data: string | number) {
    let t = CryptoJS.lib.WordArray.random(16);
    const a = CryptoJS.enc.Base64.parse(this.key);
    const n = {
      iv: t,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    };

    const s = CryptoJS.AES.encrypt(data, a, n).toString();

    const r = {
      iv: (t = CryptoJS.enc.Base64.stringify(t)),
      value: s,
      mac: CryptoJS.HmacSHA256(t + s, a).toString(),
    };

    return CryptoJS.enc.Base64.stringify(
      CryptoJS.enc.Utf8.parse(JSON.stringify(r))
    );
  }

  async GetItemByFilter(
    search?: string,
    type?: number,
    page?: number,
    year?: string,
    genre?: string
  ): Promise<ResultSearch<AnimeResult>> {
    try {
      const { data } = await axios.get(`${this.api}/api/anime/list`, {
        params: { search, type, year, genre, page },
      });

      const animeSearchParseObj = JSON.parse(this.decrypt(data.data));

      const animeSearch: ResultSearch<AnimeResult> = {
        nav: {
          count: animeSearchParseObj.data.length,
          current: animeSearchParseObj.current_page,
          next:
            animeSearchParseObj.data.length < 28
              ? 0
              : animeSearchParseObj.current_page + 1,
          hasNext: animeSearchParseObj.data.length >= 28,
        },
        results: [],
      };

      animeSearchParseObj.data.forEach((e: any) => {
        animeSearch.results.push({
          name: e.name,
          image:
            "https://www.themoviedb.org/t/p/original" +
            e.poster +
            "?&w=53&q=95",
          url: `/anime/animelatinohd/name/${e.slug}`,
          type: "",
        });
      });

      return animeSearch;
    } catch (error) {
      console.error("[AnimeLatinoHD] GetItemByFilter error:", error);
      return {
        nav: { count: 0, current: 1, next: 0, hasNext: false },
        results: [],
      };
    }
  }
}