import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const key = "129f7d85d240ac6b419fb20531bc3e08";
const token = "ATTA4bd8efd28a0174d4c6497d80739e9ef98dbc1063acd5dacf4dd0e90e9099852a70610460";

// ===== cache =====
let cachedLists = null;
let lastFetch = 0;
const CACHE_TTL = 60000;

// ===== debounce =====
const lock = new Map();

app.get("/", (_, res) => res.send("OK"));
app.get("/webhook", (_, res) => res.send("ok"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // 🔥 ตอบทันที

  try {
    const action = req.body.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const boardId = action.data.board.id;

    // ===== กัน spam =====
    if (lock.get(cardId)) return;
    lock.set(cardId, true);
    setTimeout(() => lock.delete(cardId), 150);

    // ===== โหลด FINAL STATE =====
    const { data } = await axios.get(
      `https://api.trello.com/1/cards/${cardId}/checklists`,
      { params: { key, token } }
    );

    const items = data.flatMap(c => c.checkItems);
    if (!items.length) return;

    // ===== 🔒 VALIDATE + AUTO REVERT =====
    let invalidIndex = -1;

    for (let i = 1; i < items.length; i++) {
      if (items[i].state === "complete" && items[i - 1].state !== "complete") {
        invalidIndex = i;
        break;
      }
    }

    // ❌ INVALID: มี complete หลัง incomplete
    if (invalidIndex !== -1) {

      // revert ทุกตัวหลังจาก break point
      for (let i = invalidIndex; i < items.length; i++) {
        if (items[i].state === "complete") {
          await axios.put(
            `https://api.trello.com/1/cards/${cardId}/checkItem/${items[i].id}`,
            null,
            { params: { state: "incomplete", key, token } }
          );
        }
      }

      return; // ❗ ไม่ move card
    }

    // ===== 🔒 BLOCK uncheck ย้อน =====
    // เช่น 1,2,3 checked แล้ว user uncheck 1
    for (let i = 0; i < items.length; i++) {
      if (items[i].state === "incomplete") {

        // ถ้ามีตัวหลังเป็น complete → invalid
        const hasNextComplete = items.slice(i + 1).some(x => x.state === "complete");

        if (hasNextComplete) {

          // revert ตัวนี้กลับ
          await axios.put(
            `https://api.trello.com/1/cards/${cardId}/checkItem/${items[i].id}`,
            null,
            { params: { state: "complete", key, token } }
          );

          return; // ❗ stop
        }

        break;
      }
    }

    // ===== 🧠 FINAL PROGRESS =====
    let lastComplete = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].state === "complete") lastComplete = i;
    }

    // ===== 🎯 TARGET COLUMN =====
    const columnName =
      lastComplete === -1
        ? items[0].name
        : lastComplete < items.length - 1
          ? items[lastComplete + 1].name
          : items[lastComplete].name;

    if (!columnName) return;

    // ===== 📊 PROGRESS =====
    const total = items.length;
    const done = lastComplete + 1;
    const percent = Math.round((done / total) * 100);

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

    // ===== 🚀 MOVE =====
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

app.listen(process.env.PORT || 3000);
