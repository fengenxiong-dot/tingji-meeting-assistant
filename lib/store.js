import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function wavHeader(bytes) {
  const b = Buffer.alloc(44);
  b.write('RIFF'); b.writeUInt32LE(bytes + 36, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

export class Store {
  constructor(dir) {
    this.dir = dir; mkdirSync(path.join(dir, 'audio'), { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'archive.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '', participants TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'recording', duration REAL NOT NULL DEFAULT 0,
        manual_summary TEXT, warning TEXT NOT NULL DEFAULT '',
        scenario TEXT NOT NULL DEFAULT 'meeting', paused INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS segments (id INTEGER PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id),
        start REAL NOT NULL, end REAL NOT NULL, text TEXT NOT NULL, original TEXT NOT NULL, UNIQUE(record_id,start));
      CREATE TABLE IF NOT EXISTS summaries (id INTEGER PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id),
        created TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, through REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS record_events (id INTEGER PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id),
        kind TEXT NOT NULL, audio_at REAL NOT NULL DEFAULT 0, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS segment_record ON segments(record_id,start);
      CREATE INDEX IF NOT EXISTS event_record ON record_events(record_id,id);`);
    if(!this.db.prepare('PRAGMA table_info(records)').all().some(c=>c.name==='asr_offset')) this.db.exec('ALTER TABLE records ADD COLUMN asr_offset INTEGER NOT NULL DEFAULT 0');
    const columns=this.db.prepare('PRAGMA table_info(records)').all().map(c=>c.name);
    if(!columns.includes('deleted_at'))this.db.exec('ALTER TABLE records ADD COLUMN deleted_at TEXT');
    if(!columns.includes('scenario'))this.db.exec("ALTER TABLE records ADD COLUMN scenario TEXT NOT NULL DEFAULT 'meeting'");
    if(!columns.includes('paused'))this.db.exec('ALTER TABLE records ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
    if(!columns.includes('title_mode')){
      this.db.exec("ALTER TABLE records ADD COLUMN title_mode TEXT NOT NULL DEFAULT 'manual'; ALTER TABLE records ADD COLUMN title_generated INTEGER NOT NULL DEFAULT 0;");
      this.db.exec("UPDATE records SET title_mode='auto' WHERE title='未命名会议' OR title LIKE '会议记录 %'");
    }
    for (const r of this.db.prepare("SELECT * FROM records WHERE status IN ('recording','processing')").all()) {
      const f = this.audioPath(r.id); let duration = r.duration;
      if (existsSync(f)) {
        const bytes = Math.max(0, statSync(f).size - 44); const fd = openSync(f, 'r+');
        writeSync(fd, wavHeader(bytes), 0, 44, 0); closeSync(fd); duration = bytes / 32000;
      }
      this.db.prepare("UPDATE records SET status='interrupted', duration=?, paused=0, warning=? WHERE id=?")
        .run(duration, '上次运行异常结束，已恢复收到的录音；请检查末尾文字是否完整。', r.id);
    }
  }
  audioPath(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('记录编号无效'); return path.join(this.dir, 'audio', id + '.wav'); }
  create(input = {}) {
    const id = randomUUID();
    const scenario = input.scenario === 'interview' ? 'interview' : 'meeting';
    const defaultTitle = scenario === 'interview' ? '未命名面试' : '未命名会议';
    this.db.prepare('INSERT INTO records(id,title,created,project,participants,tags,scenario) VALUES(?,?,?,?,?,?,?)')
      .run(id, String(input.title || defaultTitle).slice(0, 200), new Date().toISOString(), String(input.project || '').slice(0,200), '', '', scenario);
    if(!input.title)this.db.prepare("UPDATE records SET title_mode='auto' WHERE id=?").run(id);
    return this.record(id);
  }
  record(id) {
    const r = this.db.prepare('SELECT * FROM records WHERE id=?').get(id);
    if (!r) throw new Error('找不到这条记录');
    r.segments = this.db.prepare('SELECT * FROM segments WHERE record_id=? ORDER BY start').all(id);
    r.summaries = this.db.prepare('SELECT * FROM summaries WHERE record_id=? ORDER BY id DESC').all(id);
    r.events = this.db.prepare('SELECT * FROM record_events WHERE record_id=? ORDER BY id').all(id);
    return r;
  }
  list({ q = '', from = '', to = '', project = '', trash = false } = {}) {
    const rows = this.db.prepare(`SELECT r.*, (SELECT count(*) FROM segments WHERE record_id=r.id) AS segment_count
      FROM records r ORDER BY created DESC`).all();
    return rows.filter(r => {
      if(Boolean(r.deleted_at)!==(trash===true||trash==='true'))return false;
      const day = localDate(r.created);
      if ((from && day < from) || (to && day > to) || (project && !r.project.toLowerCase().includes(project.toLowerCase()))) return false;
      if (!q.trim()) return true;
      const hay = [r.title,r.project,r.participants,r.tags,r.scenario==='interview'?'面试':'会议',...this.record(r.id).segments.map(s=>s.text)].join('\n').toLowerCase();
      return hay.includes(q.toLowerCase().trim());
    });
  }
  update(id, patch) {
    this.record(id);
    for (const k of ['title','project','participants','tags','manual_summary','status','duration','warning','title_mode','title_generated','deleted_at','scenario','paused']) {
      if (patch[k] !== undefined) this.db.prepare(`UPDATE records SET ${k}=? WHERE id=?`).run(patch[k],id);
    }
    return this.record(id);
  }
  segment(id, start, end, text) {
    if (!text.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
    this.db.prepare('INSERT OR IGNORE INTO segments(record_id,start,end,text,original) VALUES(?,?,?,?,?)').run(id,start,end,text,text);
    return this.db.prepare('SELECT * FROM segments WHERE record_id=? AND start=?').get(id,start);
  }
  editSegment(id, sid, text) { this.db.prepare('UPDATE segments SET text=? WHERE id=? AND record_id=?').run(text,sid,id); }
  event(id, kind, audioAt = 0) {
    if (!['pause','resume'].includes(kind)) throw new Error('录音事件类型无效');
    this.record(id);
    const created = new Date().toISOString();
    this.db.prepare('INSERT INTO record_events(record_id,kind,audio_at,created) VALUES(?,?,?,?)').run(id,kind,Math.max(0,Number(audioAt)||0),created);
    return this.db.prepare('SELECT * FROM record_events WHERE record_id=? ORDER BY id DESC LIMIT 1').get(id);
  }
  summary(id, body, kind = 'auto', through = 0) {
    this.db.prepare('INSERT INTO summaries(record_id,created,kind,body,through) VALUES(?,?,?,?,?)').run(id,new Date().toISOString(),kind,body,through);
  }
  close() { this.db.close(); }
  trash(id) { return this.update(id,{deleted_at:new Date().toISOString()}); }
  restore(id) { return this.update(id,{deleted_at:null}); }
}

export function localDate(iso) {
  return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
}

export function termsOf(query) {
  const words = query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
  return [...new Set(words.flatMap(w => /[\u4e00-\u9fff]/.test(w) && w.length > 2 ? Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)) : [w]))];
}

export function retrieve(store, question, filters = {}, expanded = []) {
  const terms = [...new Set([...termsOf(question),...expanded.flatMap(termsOf)])];
  const results = [];
  for (const r of store.list({...filters,trash:false})) {
    const meta = `${r.title} ${r.project} ${r.tags} ${r.participants} ${r.scenario==='interview'?'面试':'会议'}`.toLowerCase();
    const segments = store.record(r.id).segments;
    for (let i=0; i<segments.length; i++) {
      const s = segments[i]; const txt = s.text.toLowerCase();
      const broad = /准备|提纲|归纳|总结|想法|所有|全部/.test(question);
      const score = terms.reduce((n,t)=> n + (txt.includes(t)?3:0) + (meta.includes(t)?1:0),broad?0.1:0);
      if (score > 0) {
        // Neighbor sentences preserve the context of decisions and their qualifications.
        for (const neighbor of segments.slice(Math.max(0,i-1),i+2)) results.push({...neighbor, title:r.title, created:r.created, project:r.project, scenario:r.scenario, status:r.status, score:neighbor.id===s.id?score:score*0.6});
      }
    }
  }
  const unique = new Map();
  for (const r of results.sort((a,b)=>b.score-a.score || b.created.localeCompare(a.created))) if (!unique.has(r.id)) unique.set(r.id,r);
  const all = [...unique.values()]; let size=0; const sources=[];
  // Round-robin meetings before taking second/third hits, so one long meeting cannot monopolize context.
  const groups=new Map();for(const s of all){if(!groups.has(s.record_id))groups.set(s.record_id,[]);groups.get(s.record_id).push(s);}
  const balanced=[];for(let i=0;balanced.length<all.length;i++)for(const group of groups.values())if(group[i])balanced.push(group[i]);
  for (const s of balanced) { if (sources.length>=60 || size+s.text.length>24000) continue; size+=s.text.length; sources.push({...s,label:`S${sources.length+1}`}); }
  return {sources, matched:all.length, truncated:sources.length<all.length};
}
