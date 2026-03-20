import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const key = "129f7d85d240ac6b419fb20531bc3e08";
const token = "ATTA4bd8efd28a0174d4c6497d80739e9ef98dbc1063acd5dacf4dd0e90e9099852a70610460";

// ===== cache lists (เร็วขึ้นเยอะ) =====
let cachedLists = null;
let lastFetch = 0;
const CACHE_TTL = 60000; // 60s

// ===== basic routes =====
app.get("/", (_, res) => res.send("Trello Webhook Running"));
app.get("/healthz", (_, res) => res.send("ok"));
app.get("/ping", (_, res) => res.send("pong"));
app.get("/webhook", (_, res) => res.status(200).send("ok"));

// ===== webhook =====
app.post("/webhook", async (req, res) => {

  // 🔥 ตอบทันที (ห้ามลบ)
  res.sendStatus(200);

  try {
    const action = req.body.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const boardId = action.data.board.id;
    const changed = action.data.checkItem;

    // ===== โหลด checklist =====
    const { data } = await axios.get(
      `https://api.trello.com/1/cards/${cardId}/checklists`,
      { params: { key, token } }
    );

    const items = data.flatMap(c => c.checkItems);
    const index = items.findIndex(i => i.id === changed.id);
    if (index === -1) return;

    const prev = items[index - 1];
    const next = items[index + 1];

    // ===== 🔒 BLOCK: skip step =====
    if (changed.state === "complete" && prev && prev.state !== "complete") {
      await axios.put(
        `https://api.trello.com/1/cards/${cardId}/checkItem/${changed.id}`,
        null,
        { params: { state: "incomplete", key, token } }
      );
      return;
    }

    // ===== 🔒 BLOCK: uncheck ย้อน =====
    if (changed.state === "incomplete" && next && next.state === "complete") {
      await axios.put(
        `https://api.trello.com/1/cards/${cardId}/checkItem/${changed.id}`,
        null,
        { params: { state: "complete", key, token } }
      );
      return;
    }

    // ===== guard =====
    if (prev && prev.state !== "complete") return;

    // ===== คำนวณ column =====
    const columnName =
      changed.state === "complete"
        ? (next ? next.name : items[index].name)
        : items[index].name;

    if (!columnName) return;

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

    // ===== move card =====
    await axios.put(
      `https://api.trello.com/1/cards/${cardId}`,
      null,
      { params: { idList: target.id, key, token } }
    );

  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ===== start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
