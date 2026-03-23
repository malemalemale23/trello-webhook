import express from "express";
import axios from "axios";
import Redis from "ioredis";

const app = express();
app.use(express.json());

const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;
const redis = new Redis(process.env.REDIS_URL);

// ===== cache lists =====
let cachedLists = null;
let lastFetch = 0;
const CACHE_TTL = 60000;

// ===== helpers =====
const stateKey = (id) => `s:${id}`;
const metaKey = (id) => `m:${id}`;

// ===== SYNC ครั้งเดียว =====
async function sync(cardId) {
  const { data } = await axios.get(
    `https://api.trello.com/1/cards/${cardId}/checklists`,
    { params: { key, token } }
  );

  const items = data.flatMap(c => c.checkItems);

  const ids = items.map(i => i.id);
  const names = items.map(i => i.name);
  const state = items.map(i => i.state === "complete" ? 1 : 0);

  await redis.set(metaKey(cardId), JSON.stringify({ ids, names }), "EX", 86400);
  await redis.set(stateKey(cardId), JSON.stringify(state), "EX", 86400);

  return { ids, names, state };
}

// ===== revert =====
async function revert(cardId, itemId, state) {
  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state, key, token } }
  );
}

// ===== routes =====
app.get("/", (_, res) => res.send("OK"));
app.get("/webhook", (_, res) => res.send("ok"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ⚡ instant

  try {
    const action = req.body.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const boardId = action.data.board.id;
    const item = action.data.checkItem;

    const itemId = item.id;
    const newState = item.state === "complete" ? 1 : 0;

    // ===== load cache =====
    let rawState = await redis.get(stateKey(cardId));
    let rawMeta = await redis.get(metaKey(cardId));

    let state, ids, names;

    if (!rawState || !rawMeta) {
      const synced = await sync(cardId);
      state = synced.state;
      ids = synced.ids;
      names = synced.names;
    } else {
      state = JSON.parse(rawState);
      const meta = JSON.parse(rawMeta);
      ids = meta.ids;
      names = meta.names;
    }

    const index = ids.indexOf(itemId);
    if (index === -1) return;

    // ===== 🧠 VALIDATE =====

    // ❌ skip step
    if (newState === 1 && index > 0 && state[index - 1] !== 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ uncheck กลาง
    if (newState === 0) {
      const hasNext = state.slice(index + 1).some(v => v === 1);
      if (hasNext) {
        await revert(cardId, itemId, "complete");
        return;
      }
    }

    // ===== update =====
    state[index] = newState;

    // ===== progress =====
    let last = -1;
    for (let i = 0; i < state.length; i++) {
      if (state[i] === 1) last = i;
    }

    const isActive = last !== -1 && last < state.length - 1;

    // ===== smart TTL =====
    if (isActive) {
      await redis.set(stateKey(cardId), JSON.stringify(state));
    } else {
      await redis.set(stateKey(cardId), JSON.stringify(state), "EX", 86400);
    }

    // ===== column =====
    const targetName =
      last === -1
        ? names[0]
        : last < state.length - 1
          ? names[last + 1]
          : names[last];

    if (!targetName) return;

    // ===== lists cache =====
    if (!cachedLists || Date.now() - lastFetch > CACHE_TTL) {
      const { data } = await axios.get(
        `https://api.trello.com/1/boards/${boardId}/lists`,
        { params: { key, token } }
      );
      cachedLists = data;
      lastFetch = Date.now();
    }

    const target = cachedLists.find(l => l.name === targetName);
    if (!target) return;

    await axios.put(
      `https://api.trello.com/1/cards/${cardId}`,
      null,
      { params: { idList: target.id, key, token } }
    );

  } catch (err) {
    console.error("ERR:", err.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 FINAL BOSS MODE");
});
