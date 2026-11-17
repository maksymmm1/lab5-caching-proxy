const http = require("http");
const path = require("path");
const fs = require("fs/promises");
const { Command } = require("commander");
const superagent = require("superagent");

const program = new Command();

program
  .name("main")
  .description("Кешуючий проксі-сервер для картинок http.cat")
  .helpOption("--help", "показати довідку")
  .requiredOption("-h, --host <address>", "адреса сервера")
  .requiredOption("-p, --port <number>", "порт сервера")
  .requiredOption("-c, --cache <path>", "шлях до теки кешу");

program.parse(process.argv);

const options = program.opts();
const cacheDir = path.resolve(options.cache);

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseStatusCode(urlPath) {
  const cleaned = urlPath.replace(/^\/+|\/+$/g, "");
  if (!/^\d{3}$/.test(cleaned)) return null;
  const code = Number(cleaned);
  if (code < 100 || code > 599) return null;
  return code;
}

function cacheFilePath(code) {
  return path.join(cacheDir, `${code}.jpg`);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function handleGet(code, res) {
  const filePath = cacheFilePath(code);

  if (await fileExists(filePath)) {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": data.length,
      "X-Cache": "HIT",
    });
    res.end(data);
    return;
  }

  try {
    const response = await superagent
      .get(`https://http.cat/${code}`)
      .buffer(true)
      .ok((r) => r.status < 500);

    if (response.status >= 400) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Image for status ${code} not found on http.cat`);
      return;
    }

    const image = Buffer.from(response.body);
    await fs.writeFile(filePath, image);

    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": image.length,
      "X-Cache": "MISS",
    });
    res.end(image);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Cannot fetch image for status ${code}: ${err.message}`);
  }
}

async function handlePut(code, req, res) {
  const body = await readRequestBody(req);
  await fs.writeFile(cacheFilePath(code), body);
  res.writeHead(201, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Cached image for status ${code} (${body.length} bytes)`);
}

async function handleDelete(code, res) {
  const filePath = cacheFilePath(code);

  if (!(await fileExists(filePath))) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`No cached image for status ${code}`);
    return;
  }

  await fs.unlink(filePath);
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Deleted cached image for status ${code}`);
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const urlPath = (req.url || "/").split("?")[0];
    const code = parseStatusCode(urlPath);

    if (code === null) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found. Use path like /404 with a valid HTTP status code.");
      return;
    }

    if (method === "GET") {
      await handleGet(code, res);
    } else if (method === "PUT") {
      await handlePut(code, req, res);
    } else if (method === "DELETE") {
      await handleDelete(code, res);
    } else {
      res.writeHead(405, {
        "Content-Type": "text/plain; charset=utf-8",
        Allow: "GET, PUT, DELETE",
      });
      res.end(`Method ${method} not allowed`);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Internal server error: ${err.message}`);
    }
  }
});

async function main() {
  await fs.mkdir(cacheDir, { recursive: true });
  server.listen(Number(options.port), options.host, () => {
    console.log(`Caching proxy listening on http://${options.host}:${options.port}`);
    console.log(`Cache directory: ${cacheDir}`);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});