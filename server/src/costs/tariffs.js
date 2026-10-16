/**
 * Energy tariff (currency per kWh) of a plant on the local day starting at `dayStartMs`, or null.
 * A row applies while addedDate ≤ day < changedDate (open-ended without changedDate); deleted rows never
 * apply and the latest addedDate wins (the same rule as the energy_consumption tool).
 */
export const tariffOn = (plant, dayStartMs) => {
  let best = null;
  for (const row of plant?.energyData?.energyCostHistory ?? []) {
    if (row.deleted || row.value == null) continue;
    const added = new Date(row.addedDate).getTime();
    if (!(added <= dayStartMs)) continue;
    if (row.changedDate && new Date(row.changedDate).getTime() <= dayStartMs) continue;
    if (!best || added > best.added) best = { added, value: row.value };
  }
  return best?.value ?? null;
};
