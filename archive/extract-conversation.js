#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node extract-conversation.js <input.html> [output.md]');
  process.exit(1);
}

const outputFile = process.argv[3] || inputFile.replace(/\.html$/i, '.md');
const html = fs.readFileSync(inputFile, 'utf-8');

const turnRegex = /<h2 class="sr-only">(You said|Claude responded):/g;
const turns = [];
let m;
while ((m = turnRegex.exec(html)) !== null) {
  turns.push({ role: m[1] === 'You said' ? 'user' : 'assistant', index: m.index });
}

const messages = [];
for (let i = 0; i < turns.length; i++) {
  const start = turns[i].index;
  const end = i + 1 < turns.length ? turns[i + 1].index : html.length;
  const chunk = html.substring(start, end);

  const content = turns[i].role === 'user'
    ? extractUser(chunk)
    : extractAssistant(chunk);

  messages.push({ role: turns[i].role, content });
}

let output = '';
for (const msg of messages) {
  const label = msg.role === 'user' ? '**Max:**' : '**Claude:**';
  output += `${label}\n\n${msg.content}\n\n---\n\n`;
}
output = output.replace(/---\n\n$/, '').trimEnd() + '\n';

fs.writeFileSync(outputFile, output, 'utf-8');
console.log(`Extracted ${messages.length} messages → ${outputFile}`);

function extractUser(chunk) {
  const paras = [];
  const re = /<p class="whitespace-pre-wrap break-words">([\s\S]*?)<\/p>/g;
  let pm;
  while ((pm = re.exec(chunk)) !== null) {
    paras.push(strip(pm[1]).trim());
  }
  return paras.join('\n\n') || strip(chunk).trim();
}

function extractAssistant(chunk) {
  const marker = 'class="standard-markdown';
  const idx = chunk.indexOf(marker);
  if (idx === -1) return strip(chunk).trim();

  const contentStart = chunk.indexOf('>', idx) + 1;
  const boundary = chunk.indexOf('aria-label="Message actions"', contentStart);
  let raw = boundary !== -1
    ? chunk.substring(contentStart, boundary)
    : chunk.substring(contentStart);

  return htmlToMarkdown(raw);
}

function htmlToMarkdown(src) {
  let md = src;

  md = md.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  md = md.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');

  md = md.replace(/<hr[^>]*>/g, '\n---\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, (_, t) => `\n### ${strip(t).trim()}\n`);
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/g, (_, t) => `\n#### ${strip(t).trim()}\n`);
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/g, (_, t) => `\n##### ${strip(t).trim()}\n`);

  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_, t) => `- ${strip(t).trim()}\n`);

  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_, t) => `\n${strip(t).trim()}\n`);

  md = md.replace(/<[^>]*>/g, '');
  md = md.replace(/<[^>]*$/gm, '');
  md = decodeEntities(md);
  md = md.replace(/\n{3,}/g, '\n\n').trim();

  return md;
}

function strip(text) {
  return decodeEntities(text.replace(/<[^>]+>/g, ''));
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
