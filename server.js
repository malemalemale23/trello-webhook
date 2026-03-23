import express from "express";
import axios from "axios";
import Redis from "ioredis";

const app = express();
app.use(express.json());

// ===== ENV =====
const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;
const redis = new Redis(process.env.REDIS_URL);

// ===== cache lists =====
let cachedLists = null;
let lastFetch = 0;
const CACHE_TTL = 60000;

// ===== utils =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===== routes =====
app.get("/", (_, res) => res.send("OK"));
app.get("/webhook", (_, res) => res.send("ok"));

// ===== webhook =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // 🔥 ต้องตอบทันที

  try {
    const action = req.body.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const boardId = action.data.board.id;

    // ===== 🔒 LOCK กัน spam =====
    const lockKey = `lock:${cardId}`;
    const locked = await redis.get(lockKey);
    if (locked) return;

    await redis.set(lockKey, "1", "PX", 200); // lock 200ms

    // ===== โหลด checklist (FINAL STATE) =====
    const { data } = await axios.get(
      `https://api.trello.com/1/cards/${cardId}/checklists`,
      { params: { key, token } }
    );

    const items = data.flatMap(c => c.checkItems);
    if (!items.length) return;

    // ===== 🧠 VALIDATE =====

    // หา last checked
    let lastChecked = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].state === "complete") lastChecked = i;
    }

    // ===== ❌ RULE 1: ห้าม skip =====
    for (let i = 1; i < items.length; i++) {
      if (items[i].state === "complete" && items[i - 1].state !== "complete") {
        // revert ตัวนี้
        await axios.put(
          `https://api.trello.com/1/cards/${cardId}/checkItem/${items[i].id}`,
          null,
          { params: { state: "incomplete", key, token } }
        );
        return;
      }
    }

    // ===== ❌ RULE 2: uncheck ได้เฉพาะตัวสุดท้าย =====
    for (let i = 0; i < items.length; i++) {
      if (items[i].state === "incomplete") {
        const hasCheckedAfter = items.slice(i + 1).some(x => x.state === "complete");

        if (hasCheckedAfter) {
          // ❌ user พยายาม uncheck กลาง → revert
          await axios.put(
            `https://api.trello.com/1/cards/${cardId}/checkItem/${items[i].id}`,
            null,
            { params: { state: "complete", key, token } }
          );
          return;
        }
        break;
      }
    }

    // ===== 🎯 TARGET COLUMN =====
    const columnName =
      lastChecked === -1
        ? items[0].name
        : lastChecked < items.length - 1
          ? items[lastChecked + 1].name
          : items[lastChecked].name;

    if (!columnName) return;

    // ===== cache lists =====
    if (!cachedLists || Date.now() - lastFetch > CACHE_TTL) {
      const { data: lists } = await axios.get(
        `https://api.trello.com/1/boards/${boardId}/lists`,
        { params: { key, token } }
      );
      cachedLists = lists;
      lastFetch = Date.now();
    }

    const target = cachedLists.find(l => l.name === columnName);
    if (!target) return;

    // ===== กัน move ซ้ำ =====
    const currentListId = action.data.listAfter?.id;
    if (currentListId === target.id) return;

    // ===== 🚀 MOVE CARD =====
    await axios.put(
      `https://api.trello.com/1/cards/${cardId}`,
      null,
      {
        params: {
          idList: target.id,
          key,
          token
        }
      }
    );

  } catch (err) {
    console.error("ERR:", err.message);
  }
});

// ===== start =====
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});