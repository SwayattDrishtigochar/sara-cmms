import { Router } from 'express';
import mongoose from 'mongoose';
import { AiMessage } from '../db/models/AiMessage.js';
import { notFound } from '../lib/errors.js';

/** CSV files the assistant produced (`export_csv` file blocks); mounted at /api. */
export const exportRouter = Router();

const text = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).join('; ');
  if (typeof value === 'object') return value.label ?? value.name ?? JSON.stringify(value);
  return String(value);
};

/** One CSV cell: quoted when needed; text that a spreadsheet would run as a formula is defused. */
const cell = (value) => {
  let s = text(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** CSV of `{ columns: [{ key, label, unit? }], rows }` with a BOM so Excel reads UTF-8. */
export const toCsv = ({ columns, rows }) => {
  const head = columns.map((c) => cell(c.unit ? `${c.label ?? c.key} (${c.unit})` : (c.label ?? c.key)));
  const body = rows.map((row) => columns.map((c) => cell(row[c.key])).join(','));
  return `﻿${[head.join(','), ...body].join('\r\n')}\r\n`;
};

exportRouter.get('/export/:messageId/:blockId.csv', async (req, res) => {
  const { messageId, blockId } = req.params;
  const message = mongoose.isValidObjectId(messageId)
    ? await AiMessage.findOne({ _id: messageId, companyId: req.ctx.companyId, userId: req.ctx.userId }).lean()
    : null;
  const part = message?.parts?.find((p) => p.type === 'block' && p.id === blockId && p.csv);
  if (!part) throw notFound('That file is no longer available');
  res.attachment(part.payload?.name ?? 'export.csv');
  res.type('text/csv; charset=utf-8').send(toCsv(part.csv));
});
