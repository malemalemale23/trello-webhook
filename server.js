import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// health check (สำคัญกับ Render)
app.get("/healthz", (req, res) => {
  res.send("ok");
});

app.get("/", (req, res) => {
  res.send("Trello Webhook Running");
});

app.post("/webhook", async (req, res) => {
  try {
    const action = req.body.action;

    if (!action || action.type !== "updateCheckItemStateOnCard") {
      return res.sendStatus(200);
    }

    const cardId = action.data.card.id;
    const boardId = action.data.board.id;
    const changed = action.data.checkItem;

    console.log("Triggered:", changed.name, changed.state);

    // 🔥 กัน race condition (สำคัญมาก)
    await new Promise(r => setTimeout(r, 150));

    // 🔥 โหลด checklist ใหม่ล่าสุด
    const { data } = await axios.get(
      `https://api.trello.com/1/cards/${cardId}/checklists`,
      { params: { key, token } }
    );

    const items = data.flatMap(c => c.checkItems);
    const index = items.findIndex(i => i.id === changed.id);

    if (index === -1) return res.sendStatus(200);

    const prev = index > 0 ? items[index - 1] : null;
    const next = index < items.length - 1 ? items[index + 1] : null;

    // ❌ BLOCK: ห้ามข้าม step
    if (changed.state === "complete" && prev && prev.state !== "complete") {

      await axios.put(
        `https://api.trello.com/1/cards/${cardId}/checkItem/${changed.id}`,
        null,
        { params: { state: "incomplete", key, token } }
      );

      return res.json({ blocked: "skip_step" });
    }

    // ❌ BLOCK: ห้าม uncheck ถ้า step ถัดไป complete แล้ว
    if (changed.state === "incomplete" && next && next.state === "complete") {

      await axios.put(
        `https://api.trello.com/1/cards/${cardId}/checkItem/${changed.id}`,
        null,
        { params: { state: "complete", key, token } }
      );

      return res.json({ blocked: "back_step" });
    }

    // 🧠 ถ้ายังไม่ถึง step ที่ถูกต้อง → หยุด ไม่ move card
    if (prev && prev.state !== "complete") {
      return res.sendStatus(200);
    }

    // 🔥 คำนวณ column
    let columnName;

    if (changed.state === "complete") {
      columnName = next ? next.name : items[index].name;
    }

    if (changed.state === "incomplete") {
      columnName = items[index].name;
    }

    if (!columnName) return res.sendStatus(200);

    // 🔥 หา list
    const { data: lists } = await axios.get(
      `https://api.trello.com/1/boards/${boardId}/lists`,
      { params: { key, token } }
    );

    const target = lists.find(l => l.name === columnName);
    if (!target) return res.sendStatus(200);

    // 🔥 ย้าย card (จะไม่ย้ายถ้าโดน block ด้านบน)
    await axios.put(
      `https://api.trello.com/1/cards/${cardId}`,
      null,
      { params: { idList: target.id, key, token } }
    );

    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

app.listen(3000, () => {
  console.log("Server running");
});


