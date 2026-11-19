
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  createGame,
  playerView,
  message,
  updateSuspicion,
  night,
  vote,
  guess,
  alive,
  options
} from './engine.js';

// ===============================
// 그림자 도시 5.0 서버 설정
// ===============================

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const sessions = new Map();

const MAX_SESSIONS = 500;
const TTL = 6 * 60 * 60 * 1000;

let globalCalls = [];

// ===============================
// 공통 함수
// ===============================

function reply(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });

  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let size = 0;
  const parts = [];

  for await (const chunk of req) {
    size += chunk.length;

    if (size > 12000) {
      throw Error('요청 크기 초과');
    }

    parts.push(chunk);
  }

  try {
    return JSON.parse(
      Buffer.concat(parts).toString() || '{}'
    );
  } catch {
    throw Error('잘못된 JSON');
  }
}

// ===============================
// 플레이어 세션 관리
// ===============================

function getSession(req, res) {
  const cookie = (req.headers.cookie || '').match(
    /(?:^|;\s*)sc5sid=([a-f0-9-]{36})(?:;|$)/
  );

  let sid = cookie?.[1];
  let session = sid && sessions.get(sid);

  if (!session) {
    sid = randomUUID();

    session = {
      game: null,
      last: Date.now(),
      calls: [],
      pending: false
    };

    sessions.set(sid, session);

    res.setHeader(
      'Set-Cookie',
      `sc5sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=21600${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`
    );
  }

  session.last = Date.now();

  return session;
}

// ===============================
// 채팅 권한
// ===============================

function channelAllowed(game, channel) {
  const player = game.players[0];

  if (channel === 'public') {
    return game.phase === 'day' && player.alive;
  }

  if (channel === 'mafia') {
    return player.alive && player.team === '마피아';
  }

  if (channel === 'ghost') {
    return !player.alive;
  }

  return false;
}

// ===============================
// AI에게 전달할 게임 정보
// ===============================

function contextFor(game, player, channel) {
  const recent = game.messages
    .filter(m => m.channel === channel)
    .slice(-25)
    .map(m => ({
      speaker:
        m.author === -1
          ? '시스템'
          : game.players[m.author].name,
      text: m.text
    }));

  return {
    day: game.day,
    phase: game.phase,
    channel,

    identity: {
      name: player.name,
      role: player.role,
      team: player.team,
      personality: player.personality,
      alive: player.alive
    },

    alive: alive(game).map(p => p.name),

    publicFacts: game.publicFacts.map(f => ({
      name: game.players[f.id].name,
      role: f.role,
      source: f.source
    })),

    privateIntel: Object.entries(player.intel).map(
      ([id, role]) => ({
        name: game.players[id].name,
        role
      })
    ),

    suspicions: Object.entries(player.susp)
      .map(([id, score]) => ({
        name: game.players[id].name,
        score
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5),

    votes: game.votes.slice(-3).map(v => ({
      day: v.day,
      ballots: v.ballots.map(b => ({
        from: game.players[b.from].name,
        to: game.players[b.to].name
      }))
    })),

    recent
  };
}

// ===============================
// 실제 언어 모델 호출
// ===============================

async function generate(game, player, channel, replyTo) {
  if (!KEY) {
    throw Error(
      '서버에 OPENAI_API_KEY 환경 변수가 필요합니다.'
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    25000
  );

  try {
    const prompt = `
너는 한국어 마피아 게임 참가자 ${player.name}이다.

규칙:
- 자신의 성격과 정보만 바탕으로 말한다.
- 자연스러운 1~2문장으로 대화한다.
- 최근 발언을 반복하지 않는다.
- 구체적인 주장에 답한다.
- 상황에 따라 반박하거나 질문한다.
- 모르는 사실은 모른다고 말한다.
- publicFacts는 공식적으로 확정된 사실이다.
- 단순한 의심과 확정 증거를 구분한다.
- 첫날에는 이전 투표를 언급하지 않는다.
- 다른 채널의 비밀 정보를 알 수 없다.
- 유령 채팅 정보는 부활 후 공개하지 않는다.
- 실제 능력이나 투표를 수행했다고 꾸미지 않는다.
- 대사만 출력한다.
`;

    const response = await fetch(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',

        headers: {
          authorization: `Bearer ${KEY}`,
          'content-type': 'application/json'
        },

        body: JSON.stringify({
          model: MODEL,
          instructions: prompt,

          input: JSON.stringify({
            ...contextFor(game, player, channel),
            replyTo
          }),

          max_output_tokens: 180
        }),

        signal: controller.signal
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw Error(
        data.error?.message || '모델 호출 실패'
      );
    }

    return (
      data.output_text ||
      data.output
        ?.flatMap(x => x.content || [])
        .filter(x => x.type === 'output_text')
        .map(x => x.text)
        .join('') ||
      ''
    )
      .trim()
      .slice(0, 400);

  } finally {
    clearTimeout(timeout);
  }
}

// ===============================
// AI 호출 제한
// ===============================

function checkRate(session) {
  const now = Date.now();

  session.calls = session.calls.filter(
    t => now - t < 60000
  );

  globalCalls = globalCalls.filter(
    t => now - t < 60000
  );

  if (
    session.calls.length >= 5 ||
    globalCalls.length >= 40
  ) {
    throw Error(
      'AI 호출 제한에 도달했습니다. 1분 뒤 다시 시도하세요.'
    );
  }

  session.calls.push(now);
  globalCalls.push(now);
}

// ===============================
// AI 대화 진행
// ===============================

async function aiConversation(
  session,
  channel,
  replyTo,
  requested
) {
  if (session.pending) {
    throw Error('AI가 이미 응답 중입니다.');
  }

  checkRate(session);

  session.pending = true;

  const game = session.game;

  try {
    const eligible = game.players.filter(p => {
      if (p.id === 0) return false;

      if (channel === 'ghost') {
        return !p.alive;
      }

      if (channel === 'mafia') {
        return p.alive && p.team === '마피아';
      }

      return p.alive;
    });

    const count = Math.min(
      requested ?? Math.floor(Math.random() * 6),
      5,
      eligible.length
    );

    const chosen = eligible
      .sort(() => Math.random() - 0.5)
      .slice(0, count);

    const output = [];

    for (const player of chosen) {
      if (
        session.game !== game ||
        game.phase === 'end'
      ) {
        break;
      }

      try {
        const line = await generate(
          game,
          player,
          channel,
          replyTo
        );

        if (!line) continue;

        const repeated = game.messages
          .filter(m => m.author === player.id)
          .slice(-6)
          .some(m => m.text === line);

        if (repeated) continue;

        const msg = message(
          game,
          player.id,
          line,
          channel,
          replyTo
        );

        if (channel === 'public') {
          updateSuspicion(
            game,
            player.id,
            line
          );
        }

        output.push(msg);
        replyTo = msg.id;

      } catch (error) {
        output.push({
          error: `AI 응답 실패: ${error.message}`
        });

        break;
      }
    }

    return output;

  } finally {
    session.pending = false;
  }
}

// ===============================
// 게임 API
// ===============================

const routes = {
  '/api/start': async (session, body) => {
    session.game = createGame(
      Number(body.size || 10)
    );

    return playerView(session.game);
  },

  '/api/state': async session => {
    if (!session.game) {
      throw Error('게임을 시작하세요');
    }

    return playerView(session.game);
  },

  '/api/chat': async (session, body) => {
    const game = session.game;

    if (
      !game ||
      !channelAllowed(game, body.channel)
    ) {
      throw Error('채팅 불가');
    }

    const text = String(body.text || '')
      .trim()
      .slice(0, 500);

    if (!text) {
      throw Error('메시지가 비어 있습니다');
    }

    const msg = message(
      game,
      0,
      text,
      body.channel,
      body.replyTo || null
    );

    if (body.channel === 'public') {
      updateSuspicion(game, 0, text);
    }

    return { message: msg };
  },

  '/api/respond': async (session, body) => {
    if (
      !session.game ||
      !channelAllowed(
        session.game,
        body.channel
      )
    ) {
      throw Error('대화 불가');
    }

    return {
      responses: await aiConversation(
        session,
        body.channel,
        body.replyTo
      )
    };
  },

  '/api/autotalk': async (session, body) => {
    if (
      !session.game ||
      !channelAllowed(
        session.game,
        body.channel
      )
    ) {
      throw Error('대화 불가');
    }

    return {
      responses: await aiConversation(
        session,
        body.channel,
        null,
        1 + Math.floor(Math.random() * 3)
      )
    };
  },

  '/api/night': async (session, body) => {
    if (!session.game) {
      throw Error('게임을 시작하세요');
    }

    return night(
      session.game,
      body.action || { type: 'pass' }
    );
  },

  '/api/vote': async (session, body) => {
    if (!session.game) {
      throw Error('게임을 시작하세요');
    }

    return vote(
      session.game,
      body.target === null
        ? null
        : Number(body.target)
    );
  },

  '/api/guess': async (session, body) => {
    if (!session.game) {
      throw Error('게임을 시작하세요');
    }

    return guess(
      session.game,
      0,
      Number(body.target),
      String(body.role)
    );
  },

  '/api/options': async session => {
    if (!session.game) {
      throw Error('게임을 시작하세요');
    }

    return options(session.game, 0);
  },

  '/api/advance': async session => {
    if (
      !session.game ||
      session.game.players[0].alive
    ) {
      throw Error('관전 불가');
    }

    return session.game.phase === 'night'
      ? night(session.game, { type: 'pass' })
      : vote(session.game, null);
  }
};

// ===============================
// 오래된 세션 정리
// ===============================

setInterval(() => {
  const now = Date.now();

  for (const [id, session] of sessions) {
    if (
      now - session.last > TTL &&
      !session.pending
    ) {
      sessions.delete(id);
    }
  }

  if (sessions.size > MAX_SESSIONS) {
    for (const [id, session] of sessions) {
      if (!session.pending) {
        sessions.delete(id);
      }

      if (sessions.size <= MAX_SESSIONS) {
        break;
      }
    }
  }
}, 60000).unref();

// ===============================
// HTTP 서버
// ===============================

http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    // 서버 상태 확인
    if (url.pathname === '/health') {
      return reply(res, 200, { ok: true });
    }

    // 게임 API 처리
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST') {
        return reply(res, 405, {
          error: 'POST만 허용'
        });
      }

      const origin = req.headers.origin;

      if (
        origin &&
        new URL(origin).host !== req.headers.host
      ) {
        return reply(res, 403, {
          error: '허용되지 않은 출처'
        });
      }

      const handler = routes[url.pathname];

      if (!handler) {
        return reply(res, 404, {
          error: '경로 없음'
        });
      }

      const session = getSession(req, res);

      return reply(
        res,
        200,
        await handler(
          session,
          await readBody(req)
        )
      );
    }

    // 웹페이지 요청
    if (req.method !== 'GET') {
      return reply(res, 405, {
        error: 'GET만 허용'
      });
    }

    const filename =
      url.pathname === '/'
        ? 'index.html'
        : url.pathname.slice(1);

    if (filename !== 'index.html') {
      return reply(res, 404, {
        error: '파일 없음'
      });
    }

    // ★ 수정된 부분 ★
    // public 폴더가 아닌 프로젝트 최상위의
    // index.html 파일을 불러온다.
    const data = await fs.readFile(
      path.join(ROOT, 'index.html')
    );

    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',

      'content-security-policy':
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self'; " +
        "img-src 'self' data:; " +
        "base-uri 'none'; " +
        "frame-ancestors 'none'"
    });

    res.end(data);

  } catch (error) {
    reply(res, 400, {
      error: error.message
    });
  }

}).listen(PORT, '0.0.0.0', () => {
  console.log(
    `그림자 도시 5.0 웹 서버 :${PORT} / ` +
    `모델 ${MODEL} / ` +
    `API 키 ${KEY ? '설정됨' : '미설정'}`
  );
});
