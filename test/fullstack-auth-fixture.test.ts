import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { applyFileActions, validateCodeActionPlan } from "../src/agent/actions.js";

const mainPy = String.raw`from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
import hashlib
import secrets
import sqlite3

DB = "auth.db"
tokens: dict[str, str] = {}

app = FastAPI(title="Fullstack Auth Test")

def init_db():
    with sqlite3.connect(DB) as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        )
        """)

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()

class Credentials(BaseModel):
    username: str
    password: str

@app.on_event("startup")
def startup():
    init_db()

@app.get("/", response_class=HTMLResponse)
def index():
    return """
<!doctype html>
<html>
<head><title>Auth Test</title><style>body{font-family:sans-serif;margin:2rem} input,button{margin:.25rem}</style></head>
<body>
  <h1>Fullstack Auth Test</h1>
  <input id="username" placeholder="username">
  <input id="password" placeholder="password" type="password">
  <button onclick="register()">Register</button>
  <button onclick="login()">Login</button>
  <button onclick="me()">Me</button>
  <button onclick="logout()">Logout</button>
  <pre id="out"></pre>
  <script>
    let token = localStorage.getItem("token") || "";
    const out = (value) => document.getElementById("out").textContent = JSON.stringify(value, null, 2);
    const creds = () => ({username: username.value, password: password.value});
    async function post(url, body) {
      const res = await fetch(url, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)});
      out(await res.json());
      return res;
    }
    async function register(){ await post("/api/register", creds()); }
    async function login(){ const res = await fetch("/api/login", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(creds())}); const data = await res.json(); if(data.token){ token=data.token; localStorage.setItem("token", token); } out(data); }
    async function me(){ const res = await fetch("/api/me", {headers:{"authorization":"Bearer "+token}}); out(await res.json()); }
    async function logout(){ token=""; localStorage.removeItem("token"); out({ok:true}); }
  </script>
</body>
</html>
"""

@app.post("/api/register")
def register(credentials: Credentials):
    try:
        with sqlite3.connect(DB) as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (credentials.username, hash_password(credentials.password)),
            )
        return {"ok": True}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="username already exists")

@app.post("/api/login")
def login(credentials: Credentials):
    with sqlite3.connect(DB) as conn:
        row = conn.execute(
            "SELECT username FROM users WHERE username=? AND password_hash=?",
            (credentials.username, hash_password(credentials.password)),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="invalid credentials")
    token = secrets.token_urlsafe(24)
    tokens[token] = credentials.username
    return {"token": token}

@app.get("/api/me")
def me(request: Request):
    header = request.headers.get("authorization", "")
    token = header.removeprefix("Bearer ").strip()
    username = tokens.get(token)
    if not username:
        raise HTTPException(status_code=401, detail="not authenticated")
    return {"username": username}
`;

describe("fullstack auth fixture", () => {
  it("creates a compact frontend/backend auth project from file actions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-fullstack-fixture-"));
    const plan = {
      summary: "Create compact FastAPI + SQLite auth app with embedded frontend.",
      files: [
        { path: "requirements.txt", content: "fastapi\nuvicorn\npydantic\n" },
        { path: "main.py", content: mainPy }
      ],
      commands: [
        { command: "python3 -m py_compile main.py", reason: "syntax check" },
        { command: "uvicorn main:app --reload --port 8000", reason: "run dev server" }
      ]
    };

    expect(validateCodeActionPlan(root, plan)).toEqual([]);
    await applyFileActions(root, plan.files);

    await expect(fs.readFile(path.join(root, "requirements.txt"), "utf8")).resolves.toContain("fastapi");
    await expect(fs.readFile(path.join(root, "main.py"), "utf8")).resolves.toContain("@app.post(\"/api/login\")");

    const result = await execa("python3", ["-m", "py_compile", "main.py"], { cwd: root, reject: false });
    expect(result.exitCode).toBe(0);
  });
});
