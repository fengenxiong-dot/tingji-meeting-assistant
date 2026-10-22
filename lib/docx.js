import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { marked } from 'marked';

const BODY_FONT = 'Microsoft YaHei';
const BODY_SIZE = 21;
const MUTED = '666666';

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未明确' : date.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function plainText(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inlineRuns(value, options = {}) {
  const text = String(value || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s*\n\s*/g, ' ');
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map(part => {
    if (part.startsWith('**') && part.endsWith('**')) return new TextRun({ text: part.slice(2, -2), bold: true, ...options });
    if (part.startsWith('`') && part.endsWith('`')) return new TextRun({ text: part.slice(1, -1), font: 'Consolas', ...options });
    return new TextRun({ text: part, ...options });
  });
}

function headingLevel(depth) {
  if (Number(depth) <= 1) return HeadingLevel.HEADING_1;
  if (Number(depth) === 2) return HeadingLevel.HEADING_2;
  return HeadingLevel.HEADING_3;
}

function markdownParagraphs(markdown) {
  const paragraphs = [];
  for (const token of marked.lexer(String(markdown || ''))) {
    if (token.type === 'heading') {
      paragraphs.push(new Paragraph({
        heading: headingLevel(token.depth),
        spacing: { before: 220, after: 100 },
        children: [new TextRun({ text: plainText(token.text), bold: true, color: '000000' })],
      }));
      continue;
    }
    if (token.type === 'paragraph') {
      paragraphs.push(new Paragraph({ children: inlineRuns(token.text), spacing: { after: 120 } }));
      continue;
    }
    if (token.type === 'list') {
      token.items.forEach((item, index) => {
        const prefix = token.ordered ? `${(Number(token.start) || 1) + index}. ` : '• ';
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: prefix }), ...inlineRuns(item.text)],
          indent: { left: 420, hanging: 240 },
          spacing: { after: 60 },
        }));
      });
      continue;
    }
    if (token.type === 'blockquote') {
      paragraphs.push(new Paragraph({
        children: inlineRuns(token.text),
        indent: { left: 420 },
        spacing: { after: 120 },
      }));
      continue;
    }
    if (token.type === 'code') {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: token.text, font: 'Consolas', size: 20 })],
        spacing: { after: 120 },
      }));
      continue;
    }
    if (token.type === 'table' && token.rows?.length) {
      token.rows.forEach(row => {
        paragraphs.push(new Paragraph({
          children: inlineRuns(row.map(cell => plainText(cell.text)).join(' | ')),
          spacing: { after: 60 },
        }));
      });
    }
  }
  return paragraphs;
}

function documentTitle(record) {
  const base = plainText(record.title) || '面试记录';
  if (base.endsWith('总结')) return base;
  if (base.endsWith('面试')) return `${base}总结`;
  return `${base}面试总结`;
}

export async function buildInterviewDocx(record, summary) {
  if (!record) throw new Error('找不到面试记录');
  if (record.scenario !== 'interview') throw new Error('仅面试场景支持导出 Word 文档');
  if (!String(summary || '').trim()) throw new Error('尚无面试总结，请先生成总结。');

  const metadata = [
    ['记录日期', formatDateTime(record.created)],
    ['参与人', plainText(record.participants) || '未填写'],
    ['听记场景', '面试'],
    ['录音时长', formatDuration(record.duration)],
  ];
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 150 },
      children: [new TextRun({ text: documentTitle(record), bold: true, color: '000000' })],
    }),
    ...metadata.flatMap(([label, value]) => [
      new Paragraph({
        spacing: { after: 20 },
        children: [new TextRun({ text: label, bold: true, color: '000000' }), new TextRun({ text: `：${value}`, color: MUTED })],
      }),
    ]),
    new Paragraph({ spacing: { after: 150 } }),
    ...markdownParagraphs(summary),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 260 },
      children: [new TextRun({ text: `听记君导出 · ${formatDateTime(new Date())}`, size: 16, color: MUTED })],
    }),
  ];

  const document = new Document({
    creator: '听记君',
    title: documentTitle(record),
    description: '面试总结',
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_SIZE, color: '000000' },
          paragraph: { spacing: { line: 300, after: 100 } },
        },
      },
    },
    sections: [{
      properties: {
        page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } },
      },
      children,
    }],
  });

  return Packer.toBuffer(document);
}
