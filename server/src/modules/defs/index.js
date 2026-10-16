import ai from './ai.js';
import attendance from './attendance.js';
import bins from './bins.js';
import inventory from './inventory.js';
import maintenance from './maintenance.js';
import org from './org.js';
import production from './production.js';
import rules from './rules.js';
import system from './system.js';

export const defs = [
  ...org,
  ...attendance,
  ...maintenance,
  ...inventory,
  ...production,
  ...bins,
  ...rules,
  ...system,
  ...ai,
];
