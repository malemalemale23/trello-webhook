import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const key = "129f7d85d240ac6b419fb20531bc3e08";
const token = "ATTA4bd8efd28a0174d4c6497d80739e9ef98dbc1063acd5dacf4dd0e90e9099852a70610460";

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

    // โหลด checklist
    const { data } = await axios.get(
      `https://api.trello.com/1/cards/${cardId}/checklists`,
      { params: { key, token } }
    );

    const items = data.flatMap(c => c.checkItems);
    const index = items.findIndex(i => i.id === changed.id);

    if (index === -1) return res.sendStatus(200);

    const prev = index > 0 ? items[index - 1] : null;
    const next = index < items.length - 1 ? items[index + 1] : null;

    // ❌ block uncheck previous
    if (changed.state === "incomplete" && next?.state === "complete") {

      await axios.put(
        `https://api.trello.com/1/cards/${cardId}/checkItem/${changed.id}`,
        {},
        { params: { state: "complete", key, token } }
      );

      return res.sendStatus(200);
    }

    // ❌ block skip step
    if (changed.state === "complete" && prev && prev.state !== "complete") {

      await axios.put(
        `https://api.trello.com/1/cards/${cardId}/checkItem/${changed.id}`,
        {},
        { params: { state: "incomplete", key, token } }
      );

      return res.sendStatus(200);
    }

    // 🧠 guard
    if (prev && prev.state !== "complete") {
      return res.sendStatus(200);
    }

    let columnName;

    if (changed.state === "complete") {
      columnName = next ? next.name : items[index].name;
    }

    if (changed.state === "incomplete") {
      columnName = items[index].name;
    }

    if (!columnName) return res.sendStatus(200);

    const { data: lists } = await axios.get(
      `https://api.trello.com/1/boards/${boardId}/lists`,
      { params: { key, token } }
    );

    const target = lists.find(l => l.name === columnName);
    if (!target) return res.sendStatus(200);

    await axios.put(
      `https://api.trello.com/1/cards/${cardId}`,
      {},
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
