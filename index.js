/*
------------------------------------------
@Author: 乐维(lewei)
@Description: 比亚迪海洋(mina) - 微信小程序静默登录 + 每日签到（YYB网关直连·单文件自包含版）
cron: 10 0 * * *
------------------------------------------
变量名：user_account
变量值：网关里的 openid（即 ref），多账号用 & 或换行分隔（可加 #备注）
        不配置时使用脚本内置的 DEFAULT_ACCOUNTS

可选变量（均有默认值）：
yyb_url    默认 http://yyb-go:8000
yyb_token  默认内置 Bearer token
------------------------------------------
契约（appid wxf62054ec313d6f53，host mina.bydoceanauto.com）：

取码  POST {yyb_url}/wxapp/getCode  头 Authorization: Bearer {yyb_token}
        body={"app_id": appid, "ref": openid}
        -> code==0 && data.result.code（errMsg=="login:ok"）
登录  POST /?service=mina.decryptCode  body=AES({code}) -> 解密得 session_id
签到  POST /?s=ForCommonUcSrv.forward&serviceDir=activity/sign/signIn
        body=AES({date:"",belong_brand:"hy",session_id,app_version:"460",app_client:"mina"}) -> ret==0 成功
        ret==200 = 重复签到（msg 通常为 success!，data 可能带 duplicate/积分，别当失败）
        ret==50010「请下载最新比亚迪APP完成账号升级」= 该账号未在比亚迪App完成升级/注册（也可能是缓存session状态过期，脚本会自动清缓存重登重试一次）
AES_KEY/IV、APPKEY、APPSECRET 是这家小程序固定加密常量（非个人凭证）。
------------------------------------------
*/

const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ==================== 内置配置（环境变量优先，未配置时用这里的默认值） ====================
const DEFAULT_ACCOUNTS = "你的opnid，在网关处获取"; // user_account 变量未配置时使用的 openid，多账号用 & 分隔
const YYB_URL = (process.env.yyb_url || "http://yyb-go:8000").replace(/\/+$/, "");
const YYB_TOKEN = process.env.yyb_token || "网关鉴权密钥 token";
// ====================================================================================

const ckName = "user_account";
const MINI_APP_ID = "wxf62054ec313d6f53";
const BASE = "https://mina.bydoceanauto.com";
const AES_KEY = "3993014457161851";
const AES_IV = "PDVcDRWMrBlLHTqh";
const APPKEY = "hyMinaApi";
const APPSECRET = "Kfl%BOk6C5PwARw8";
const TOKEN_CACHE_FILE = path.join(__dirname, "bydhy_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const DECRYPT_CODE_URL = `${BASE}/?service=mina.decryptCode`;
const SIGN_URL = `${BASE}/?s=ForCommonUcSrv.forward&serviceDir=activity/sign/signIn`;

// ==================== 内联 Env（单文件自包含，不依赖 tools/env.js） ====================
class Env {
    constructor(name) {
        this.name = name;
        this.userIdx = 1;
        this.userList = [];
        this.userCount = 0;
        this.notifyStr = [];
        this.startTime = Date.now();
        this.log(`🔔${this.name},开始!`);
    }
    checkEnv(ckName, def = "") {
        const userCookie = process.env[ckName] || def;
        const sep = ["&", "\n"].find((o) => userCookie.includes(o)) || "&";
        this.userList = userCookie.split(sep).map((s) => s.trim()).filter(Boolean);
        this.userCount = this.userList.length;
        this.log(`共找到${this.userCount}个账号${process.env[ckName] ? "" : "（内置配置）"}`);
    }
    log(content) {
        const t = content instanceof Error ? content.stack || content.message : String(content);
        const time = new Date().toTimeString().slice(0, 8);
        this.notifyStr.push(`[${time}] ${t}`);
        console.log(t);
    }
    wait(min, max = null) {
        const ms = max == null ? min : (Math.random() * (max - min + 1) + min) | 0;
        return new Promise((r) => setTimeout(r, ms));
    }
    async sendMsg() {
        const message = this.notifyStr.join("\n");
        const candidates = [
            path.join(__dirname, "sendNotify.js"),
            path.join(__dirname, "../sendNotify.js"),
            "/ql/data/scripts/sendNotify.js",
            "/ql/scripts/sendNotify.js",
        ];
        for (const p of candidates) {
            try {
                const { sendNotify } = require(p);
                await sendNotify(this.name, message);
                return;
            } catch (e) {
                if (e.code !== "MODULE_NOT_FOUND") this.log(`发送通知失败: ${e.message}`);
            }
        }
    }
    async done() {
        await this.sendMsg();
        const cost = (Date.now() - this.startTime) / 1000;
        this.log(`🔔${this.name},结束!🕛 ${cost}秒`);
        process.exit(0);
    }
}
const $ = new Env("比亚迪海洋签到(YYB)");
// ====================================================================================

function readCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}
function writeCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入缓存失败: ${e.message || e}`);
    }
}
function parseAccount(raw = "") {
    const [id, remark] = String(raw).split("#").map((s) => (s || "").trim());
    return { openid: id, remark: remark || "" };
}
function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function aesEncrypt(text) {
    const c = crypto.createCipheriv("aes-128-cbc", AES_KEY, AES_IV);
    return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("base64");
}
function aesDecrypt(b64) {
    try {
        const d = crypto.createDecipheriv("aes-128-cbc", AES_KEY, AES_IV);
        return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8");
    } catch (e) {
        return null;
    }
}
function genNonce(n = 16) {
    const cs = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return Array.from({ length: n }, () => cs[Math.floor(Math.random() * cs.length)]).join("");
}
function commonHeaders() {
    const nonce = genNonce();
    const curtime = String(Math.floor(Date.now() / 1000));
    return {
        "Content-Type": "application/json",
        "X-Clienttraceid": `mina-${crypto.randomUUID()}`,
        Nonce: nonce,
        Curtime: curtime,
        Checksum: crypto.createHash("sha256").update(`${APPSECRET}${nonce}${curtime}`).digest("hex"),
        Appkey: APPKEY,
        "User-Agent": USER_AGENT,
        Xweb_xhr: "1",
        Accept: "*/*",
        Referer: `https://servicewechat.com/${MINI_APP_ID}/115/page-frame.html`,
    };
}

/** 向 YYB 网关取 wx.login 的 code */
async function fetchCode(openid, log = () => {}) {
    const url = `${YYB_URL}/wxapp/getCode`;
    const headers = { Authorization: `Bearer ${YYB_TOKEN}`, "Content-Type": "application/json" };
    const body = { app_id: MINI_APP_ID, ref: openid };
    log(`[请求] POST ${url}\n  请求头: ${JSON.stringify(headers)}\n  请求参数: ${JSON.stringify(body)}`);
    let res;
    try {
        res = await axios.request({
            method: "POST",
            url,
            data: body,
            headers,
            timeout: 30000,
            validateStatus: () => true,
        });
    } catch (e) {
        log(`[响应] POST ${url} 请求异常: ${e.message || e}`);
        throw e;
    }
    log(`[响应] POST ${url}\n  状态码: ${res.status}\n  响应内容: ${short(res.data, 1000)}`);
    const d = res.data || {};
    if (d.code !== 0) throw new Error(`网关取code失败: ${d.msg || short(d)}`);
    const result = d.data && d.data.result;
    const code = result && result.code;
    if (!code || typeof code !== "string") {
        throw new Error(`网关未返回 code（${result && result.errMsg ? result.errMsg : short(d)}）`);
    }
    return code;
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.sessionId = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    /** 发 AES 加密请求，返回解密后的对象 */
    async post(url, plainObj) {
        const headers = commonHeaders();
        const body = aesEncrypt(JSON.stringify(plainObj));
        this.log(`[请求] POST ${url}\n  请求头: ${JSON.stringify(headers)}\n  请求参数(明文): ${JSON.stringify(plainObj)}\n  请求参数(密文): ${body}`);
        let res;
        try {
            res = await axios.request({
                method: "POST", url, data: body,
                headers, timeout: 20000, validateStatus: () => true,
                transformRequest: [(d) => d],
            });
        } catch (e) {
            this.log(`[响应] POST ${url} 请求异常: ${e.message || e}`);
            throw e;
        }
        const t = typeof res.data === "string" ? res.data.trim() : JSON.stringify(res.data);
        const dec = aesDecrypt(t);
        this.log(`[响应] POST ${url}\n  状态码: ${res.status}\n  响应(原文): ${short(t, 1000)}\n  响应(解密): ${short(dec, 1000)}`);
        if (dec) { try { return JSON.parse(dec); } catch (e) {} }
        if (res.data && typeof res.data === "object") return res.data;
        try { return JSON.parse(t); } catch (e) { return { _raw: t.slice(0, 160) }; }
    }
    async login() {
        const code = await fetchCode(this.account.openid, (t) => this.log(t));
        const res = await this.post(DECRYPT_CODE_URL, { code });
        this.sessionId = res.session_id || (res.data || {}).session_id || "";
        if (!this.sessionId) throw new Error(`登录未获得 session_id: ${short(res)}`);
        const cache = readCache();
        cache[this.account.openid] = { sessionId: this.sessionId, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }
    async sign(retry = true) {
        const res = await this.post(SIGN_URL, { date: "", belong_brand: "hy", session_id: this.sessionId, app_version: "460", app_client: "mina" });
        const ret = Number(res?.ret);
        const msg = res?.msg || res?.message || "";
        if (ret === 0) {
            const d = res.data || {};
            return this.log(`✅ 签到成功${d.integral !== undefined ? `，积分 ${d.integral}` : ""}${d.continuous !== undefined ? `，连续 ${d.continuous} 天` : ""}${msg ? `（${msg}）` : ""}`);
        }
        // 重复签到：ret=200（服务端约定，msg 通常为 "success!"，data 可能带 duplicate/积分信息）
        if (ret === 200) {
            const d = res.data && typeof res.data === "object" ? res.data : {};
            return this.log(`✅ 今日已签到${d.integral !== undefined ? `，积分 ${d.integral}` : ""}${d.durationDays !== undefined ? `，已连续 ${d.durationDays} 天` : ""}`);
        }
        if (/已签|签到过|重复|已完成/.test(msg)) return this.log(`✅ 今日已签到（${msg}）`);
        if (ret === 50010 && retry) {
            this.log("服务端报账号未升级，可能是缓存session状态过期，清除缓存重新登录后重试");
            const cache = readCache();
            delete cache[this.account.openid];
            writeCache(cache);
            this.sessionId = "";
            await this.login();
            return this.sign(false);
        }
        if (ret === 50010) return this.log(`⚠️ 该微信号的比亚迪账号未完成升级/注册（${msg}），需先在比亚迪App里完成账号升级`);
        if (retry && /session|登录|未授权|失效|过期|token/i.test(msg)) {
            this.log("会话失效，重新登录后重试");
            this.sessionId = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败(ret=${ret}): ${msg || short(res)}`);
    }
    async ensureLogin() {
        const cached = readCache()[this.account.openid] || {};
        // session 缓存按天刷新：缓存不是当天获取的就视为过期，重新登录
        const today = new Date().toLocaleDateString("zh-CN");
        const cachedDay = cached.updatedAt ? new Date(cached.updatedAt).toLocaleDateString("zh-CN") : "";
        if (!this.sessionId && cached.sessionId && cachedDay === today) {
            this.sessionId = cached.sessionId;
            this.log("使用缓存session（今日已获取）");
            return;
        }
        if (!this.sessionId && cached.sessionId) this.log("缓存session为旧日期，重新登录刷新");
        if (!this.sessionId) await this.login();
    }
    async run() {
        if (!this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();
            await this.sign();
        } catch (e) {
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    $.checkEnv(ckName, DEFAULT_ACCOUNTS);
    if (!$.userCount) { $.log(`未找到变量 ${ckName}，且脚本未内置账号`); return; }
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i]).run();
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
