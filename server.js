import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const key = "YOUR_KEY";
const token = "YOUR_TOKEN";

// ===== cache =====
let cachedLists = null;
let lastFetch = 0;
const CACHE_TTL = 60000;

// ===== debounce ต่อ card =====
const processing = new Map();

// ===== routes =====
app.get("/", (_, res) => res.send("Trello Webhook Running"));
app.get("/healthz", (_, res) => res.send("ok"));
app.get("/webhook", (_, res) => res.status(200).send("ok"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // 🔥 respond ทันที

  try {
    const action = req.body.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const boardId = action.data.board.id;

    // ===== debounce กัน spam =====
    if (processing.get(cardId)) return;
    processing.set(cardId, true);
    setTimeout(() => processing.delete(cardId), 200);

    // ===== โหลด FINAL STATE =====
    const { data } = await axios.get(
      `https://api.trello.com/1/cards/${cardId}/checklists`,
      { params: { key, token } }
    );

    const items = data.flatMap(c => c.checkItems);
    if (!items.length) return;

    // ===== 🔒 VALIDATE STATE =====
    // ห้ามมี complete หลัง incomplete
    for (let i = 1; i < items.length; i++) {
      if (items[i].state === "complete" && items[i - 1].state !== "complete") {

        // revert ตัวที่ผิด
        await axios.put(
          `https://api.trello.com/1/cards/${cardId}/checkItem/${items[i].id}`,
          null,
          { params: { state: "incomplete", key, token } }
        );

        return; // ❗ หยุด ไม่ move
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

    // ===== โหลด lists (cache) =====
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

    // ===== 🔍 check current column (กัน move ซ้ำ) =====
    const currentListId = action.data.listAfter?.id;
    if (currentListId === target.id) return;

    // ===== 🚀 MOVE + UPDATE TITLE =====
    await axios.put(
      `https://api.trello.com/1/cards/${cardId}`,
      null,
      {
        params: {
          idList: target.id,
          name: `(${done}/${total}) ${percent}%`,
          key,
          token
        }
      }
    );

  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ===== start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
