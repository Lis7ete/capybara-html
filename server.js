кnotepad



const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "public");
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(
    new URL(req.url, "http://localhost").pathname
  );
  const file = path.join(ROOT, pathname === "/" ? "index.html" : pathname);

  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, "index.html")) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    const ext = path.extname(file);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
const sockets = new Map();

const randomCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const send = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
};

function newPlant(id) {
  const type = ["bamboo", "bamboo", "sun", "daisy"][
    Math.floor(Math.random() * 4)
  ];
  const island = Math.random() < 0.55;
  return {
    id,
    type,
    x: island ? 600 + Math.random() * 340 : 45 + Math.random() * 330,
    y: 65 + Math.random() * 490
  };
}

function createWorld() {
  const plants = [];
  for (let i = 0; i < 45; i++) plants.push(newPlant(i));
  return { plants, nextPlant: 45 };
}

function addPlayer(room, ws, name) {
  const id = crypto.randomUUID();
  const player = {
    id,
    name: String(name || "Капибара").slice(0, 18),
    x: room.players.size ? 150 : 120,
    y: 310,
    bamboo: 0,
    sun: 0,
    daisy: 0,
    coins: 0,
    sold: 0,
    capacity: 10,
    speed: 165,
    price: 3,
    input: { w: false, a: false, s: false, d: false }
  };
  room.players.set(id, player);
  sockets.set(ws, { room, id });
  ws.roomId = room.code;
  send(ws, { type: "welcome", id, code: room.code });
  return player;
}

function publicState(room) {
  return {
    type: "state",
    code: room.code,
    players: [...room.players.values()],
    plants: room.plants,
    maxPlayers: 8
  };
}

function broadcast(room) {
  const data = JSON.stringify(publicState(room));
  for (const ws of room.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function removeSocket(ws) {
  const info = sockets.get(ws);
  if (!info) return;
  const { room, id } = info;
  room.players.delete(id);
  room.clients.delete(ws);
  sockets.delete(ws);

  if (room.clients.size === 0) {
    rooms.delete(room.code);
  } else {
    broadcast(room);
  }
}

function walkable(x, y) {
  if (x < 20 || x > 980 || y < 20 || y > 600) return false;

  const oval = (cx, cy, rx, ry) =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

  return oval(225, 310, 230, 245) ||
    oval(780, 310, 185, 190) ||
    (x >= 405 && x <= 595 && Math.abs(y - 310) < 27);
}

const panda = { x: 300, y: 280 };
const cat = { x: 815, y: 300 };

function closeTo(a, b, distance) {
  return Math.hypot(a.x - b.x, a.y - b.y) < distance;
}

function sell(room, player, ws) {
  const trader = closeTo(player, panda, 78) ? "Панда" :
    closeTo(player, cat, 78) ? "Кот" : null;

  if (!trader) {
    send(ws, { type: "notice", text: "Подойди к панде или коту!" });
    return;
  }

  const total = player.bamboo + player.sun + player.daisy;
  if (!total) {
    send(ws, { type: "notice", text: trader + ": принеси растения!" });
    return;
  }

  const earned =
    player.bamboo * player.price +
    player.sun * (player.price + 2) +
    player.daisy * (player.price + 1);

  player.coins += earned;
  player.sold += total;
  player.bamboo = 0;
  player.sun = 0;
  player.daisy = 0;

  send(ws, {
    type: "notice",
    text: trader + " купил растения! +" + earned + " монет 🪙"
  });
}

function upgrade(player, kind, ws) {
  const cost = kind === "bag" ? player.capacity * 2 + 10 :
    kind === "speed" ? 40 + player.speed - 165 :
    kind === "price" ? 60 + (player.price - 3) * 30 : 0;

  if (!cost) return;
  if (player.coins < cost) {
    send(ws, { type: "notice", text: "Не хватает монет! Нужно " + cost });
    return;
  }

  player.coins -= cost;
  if (kind === "bag") player.capacity += 10;
  if (kind === "speed") player.speed += 30;
  if (kind === "price") player.price++;

  send(ws, { type: "notice", text: "Улучшение куплено!" });
}

wss.on("connection", ws => {
  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "create") {
      if (sockets.has(ws)) return;

      if (rooms.size >= 500) {
        send(ws, { type: "error", text: "Сервер заполнен." });
        return;
      }

      let code;
      do { code = randomCode(); } while (rooms.has(code));

      const room = {
        code,
        clients: new Set([ws]),
        players: new Map(),
        plants: createWorld().plants,
        nextPlant: 45
      };

      rooms.set(code, room);
      addPlayer(room, ws, msg.name);
      send(ws, { type: "notice", text: "Лобби создано! Пригласи друзей по коду." });
      broadcast(room);
      return;
    }

    if (msg.type === "join") {
      if (sockets.has(ws)) return;
      const code = String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);

      if (!room) {
        send(ws, { type: "error", text: "Комната не найдена. Проверь код." });
        return;
      }
      if (room.clients.size >= 8) {
        send(ws, { type: "error", text: "В комнате уже 8 игроков." });
        return;
      }

      room.clients.add(ws);
      addPlayer(room, ws, msg.name);
      broadcast(room);
      for (const client of room.clients) {
        if (client !== ws) send(client, {
          type: "notice", text: "Друг присоединился! 👥"
        });
      }
      return;
    }

    const info = sockets.get(ws);
    if (!info) return;
    const { room, id } = info;
    const player = room.players.get(id);
    if (!player) return;

    if (msg.type === "input") {
      const input = msg.input || {};
      player.input = {
        w: !!input.w, a: !!input.a,
        s: !!input.s, d: !!input.d
      };
    }

    if (msg.type === "sell") sell(room, player, ws);

    if (msg.type === "upgrade") {
      if (["bag", "speed", "price"].includes(msg.kind)) {
        upgrade(player, msg.kind, ws);
      }
    }
  });

  ws.on("close", () => removeSocket(ws));
  ws.on("error", () => removeSocket(ws));
});

setInterval(() => {
  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      const i = player.input;
      let dx = Number(i.d) - Number(i.a);
      let dy = Number(i.s) - Number(i.w);
      if (dx && dy) {
        dx *= Math.SQRT1_2;
        dy *= Math.SQRT1_2;
      }

      const nx = player.x + dx * player.speed / 30;
      const ny = player.y + dy * player.speed / 30;

      if (walkable(nx, player.y)) player.x = nx;
      if (walkable(player.x, ny)) player.y = ny;

      const total = player.bamboo + player.sun + player.daisy;
      if (total < player.capacity) {
        const index = room.plants.findIndex(p =>
          closeTo(player, p, 24)
        );
        if (index !== -1) {
          const plant = room.plants.splice(index, 1)[0];
          if (plant.type === "bamboo") player.bamboo++;
          if (plant.type === "sun") player.sun++;
          if (plant.type === "daisy") player.daisy++;
        }
      }
    }

    while (room.plants.length < 45) {
      room.plants.push(newPlant(room.nextPlant++));
    }
    broadcast(room);
  }
}, 1000 / 30);

server.listen(PORT, "0.0.0.0", () => {
  console.log("Capybara server listening on port " + PORT);
});