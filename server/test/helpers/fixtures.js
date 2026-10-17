import bcrypt from 'bcryptjs';
import { Counter } from '../../src/db/models/Counter.js';
import { conflict } from '../../src/lib/errors.js';
import { secondsToHms } from '../../src/lib/format.js';
import { oid, prng } from '../../src/lib/ids.js';
import { REJECTION_REASONS } from '../../src/modules/defs/production.js';
import { permissionMap } from '../../src/modules/permissions.js';
import { getModule } from '../../src/modules/registry.js';
import * as bp from './fixtureData.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const Model = (name) => getModule(name).Model;

export const slugify = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'account';

/**
 * Validates, applies schema defaults and inserts in bulk while keeping explicit
 * createdAt/updatedAt (Mongoose timestamps would overwrite them on create()).
 */
const bulkInsert = async (name, docs, now) => {
  if (!docs.length) return [];
  const M = Model(name);
  const raw = docs.map((doc) => {
    const m = new M(doc);
    const err = m.validateSync();
    if (err) throw new Error(`${name}: ${err.message}`);
    const obj = m.toObject({ depopulate: true });
    if (M.schema.options.timestamps) {
      obj.createdAt ??= now;
      obj.updatedAt ??= obj.createdAt;
    }
    return obj;
  });
  await M.collection.insertMany(raw, { ordered: true });
  return raw;
};

const weightedPick = (rng, weighted) => {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let roll = rng.next() * total;
  for (const [value, w] of weighted) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return weighted.at(-1)[0];
};

const applyPreset = (preset) => {
  const perms = permissionMap(false);
  for (const [key, actions] of Object.entries(bp.PERMISSION_PRESETS[preset] ?? {})) {
    for (const action of actions) perms[key][action] = true;
  }
  return perms;
};

/**
 * TEST ONLY. Seeds a complete, believable plant company: users with role-based emails
 * (production_technician_1@<domain> …), plants with shifts, machines, moulds, stores, PM schedules,
 * 60 days of work orders, production plans and job cards. Ids are derived from the slug, so seeding
 * again gives the same ids. withHistory adds downtime/rejection history (what telemetry would produce).
 */
export const seedCompany = async ({
  name = 'Acme Components',
  slug = slugify(name),
  domain = 'swayatt.com',
  industry = 'Automotive components',
  location = 'Pune, Maharashtra',
  plantNames = ['Pune', 'Chennai'],
  features = {
    productionEnabled: true,
    energyEnabled: true,
    binTrackingEnabled: false,
    isMasterReportEnabled: true,
  },
  password,
  withHistory = false,
  now = new Date(),
} = {}) => {
  if (!password) throw new Error('seedCompany needs a password for the generated users');
  const id = (key) => oid(`${slug}:${key}`);
  const rng = prng(slug);
  const companyId = id('company');
  if (await Model('companies').exists({ _id: companyId })) {
    throw conflict(`An account with the id "${slug}" already exists`);
  }
  const tenant = (doc) => ({ companyId, ...doc });

  // ── Company & plants ──────────────────────────────────────────────────────
  await bulkInsert(
    'companies',
    [
      {
        _id: companyId,
        name,
        industry,
        location,
        companyEmail: `info@${domain}`,
        domain,
        subscription: { status: 'active', currentPlan: 'enterprise' },
        features,
        preferences: {
          timeZone: 'Asia/Kolkata',
          dateFormat: 'DD-MM-YYYY',
          timeFormat: '12-hours',
          currency: { name: 'INR', symbol: '₹' },
        },
      },
    ],
    now,
  );

  const plants = plantNames.slice(0, 3).map((plantName) => {
    const info = bp.PLANTS[plantName] ?? { code: plantName.slice(0, 3).toUpperCase(), location: plantName };
    return tenant({
      _id: id(`plant:${plantName}`),
      name: `${plantName} Plant`,
      plantCode: info.code,
      location: info.location,
      shifts: bp.SHIFTS.map((s) => ({ ...s, _id: id(`plant:${plantName}:shift:${s.shiftName}`) })),
      runningSchedule: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      holidays: bp.HOLIDAYS.map((h) => ({
        date: new Date(`${h.date}T00:00:00+05:30`),
        description: h.description,
      })),
      energyData: {
        energyCostHistory: [
          {
            value: 7.8,
            addedDate: new Date('2026-01-01T00:00:00+05:30'),
            changedDate: new Date('2026-07-01T00:00:00+05:30'),
          },
          { value: 8.4, addedDate: new Date('2026-07-01T00:00:00+05:30') },
        ],
        energyEmissionHistory: [{ value: 0.71, date: new Date('2026-01-01T00:00:00+05:30') }],
      },
    });
  });
  await bulkInsert('plants', plants, now);
  const plantAt = (index) => (index == null ? null : (plants[index]?._id ?? null));

  // ── People ────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(password, 10);
  const roster = bp.ROSTER.filter((r) => r.plant == null || r.plant < plants.length);
  const takenEmails = new Set(
    (
      await Model('users')
        .find({ email: { $in: roster.map((r) => `${r.key}@${domain}`) } })
        .select('email')
        .lean()
    ).map((u) => u.email),
  );
  const users = roster.map((r) =>
    tenant({
      _id: id(`user:${r.key}`),
      firstName: r.first,
      lastName: r.last,
      email: takenEmails.has(`${r.key}@${domain}`) ? `${r.key}.${slug}@${domain}` : `${r.key}@${domain}`,
      password: hash,
      role: r.role,
      department: r.department,
      userTitle: r.title,
      employeeId: `EMP-${String(roster.indexOf(r) + 101)}`,
      phoneNumber: `+91 98${rng.int(10000000, 99999999)}`,
      plantId: plantAt(r.plant),
      shiftId: r.plant != null ? String(plants[r.plant].shifts[roster.indexOf(r) % 2]._id) : undefined,
      skills: r.skills ?? [],
      permissions: r.role === 'technician' ? applyPreset(r.perms) : undefined,
      createdAt: new Date(now - 120 * DAY),
    }),
  );
  await bulkInsert('users', users, now);
  const userByKey = Object.fromEntries(roster.map((r, i) => [r.key, users[i]]));
  const owner = userByKey.owner_1;
  const techsOf = (plantId) =>
    users.filter(
      (u) =>
        u.role === 'technician' && u.department === 'Maintenance' && String(u.plantId) === String(plantId),
    );
  const productionCrew = users.filter((u) => u.department === 'Production' && u.role === 'technician');

  await bulkInsert(
    'usergroups',
    bp.GROUPS.map((g) =>
      tenant({
        _id: id(`group:${g.name}`),
        name: g.name,
        plantId: plants[0]._id,
        members: g.members.map((key) => userByKey[key]?._id).filter(Boolean),
      }),
    ),
    now,
  );
  await bulkInsert(
    'costsettings',
    [
      tenant({
        _id: id('costsettings'),
        laborRatePerHour: 350,
        defaultDowntimeCostPerHour: 3000,
        monthlyMaintenanceBudget: 250000,
        monthlyEnergyBudget: 900000,
      }),
    ],
    now,
  );

  // ── Machines ──────────────────────────────────────────────────────────────
  const assetSpecs = bp.ASSETS.filter(
    (a) => a.plant < plants.length && (features.productionEnabled || !a.prod),
  );
  const assets = assetSpecs.map((a) =>
    tenant({
      _id: id(`asset:${a.tag}`),
      name: a.name,
      assetTag: a.tag,
      typeOfAsset: a.type,
      plantId: plants[a.plant]._id,
      assetStatus: 'OFF',
      criticality: a.crit,
      manufacturer: a.make,
      modelOfAsset: a.model,
      serialNumber: `${a.make.slice(0, 3).toUpperCase()}-${rng.int(100000, 999999)}`,
      location: a.loc,
      isProductionAsset: Boolean(a.prod),
      isEnergyAsset: Boolean(a.energy),
      isSensorIntegration: Boolean(a.sensor),
      ratedPowerKw: a.kw || undefined,
      downtimeCostPerHour: a.cost || undefined,
      downtimeSeconds: 600,
      installationDate: new Date(now - rng.int(2, 8) * 365 * DAY),
      warrantyExpiryDate: new Date(now.getTime() + rng.int(-300, 500) * DAY),
      createdAt: new Date(now - 120 * DAY),
    }),
  );
  await bulkInsert('assets', assets, now);
  const assetByTag = Object.fromEntries(assetSpecs.map((a, i) => [a.tag, assets[i]]));

  // ── Partners & stores ────────────────────────────────────────────────────
  const plant0 = plants[0]._id;
  const suppliers = bp.SUPPLIERS.map((s) =>
    tenant({
      _id: id(`supplier:${s.code}`),
      name: s.name,
      supplierCode: s.code,
      leadTimeDays: s.lead,
      contactPerson: s.contact,
      email: `sales@${slugify(s.name)}.example.com`,
      phone: `+91 20 ${rng.int(2000, 6999)} ${rng.int(1000, 9999)}`,
      plantId: plant0,
    }),
  );
  await bulkInsert('suppliers', suppliers, now);
  const supplierByCode = Object.fromEntries(bp.SUPPLIERS.map((s, i) => [s.code, suppliers[i]]));
  await bulkInsert(
    'vendors',
    bp.VENDORS.map((v) =>
      tenant({
        _id: id(`vendor:${v.code}`),
        name: v.name,
        vendorCode: v.code,
        services: v.services,
        contactPerson: v.contact,
        email: `service@${slugify(v.name)}.example.com`,
        plantId: plant0,
      }),
    ),
    now,
  );

  const parts = bp.SPARE_PARTS.map((p) =>
    tenant({
      _id: id(`part:${p.no}`),
      name: p.name,
      partNumber: p.no,
      minimumQuantity: p.min,
      criticality: p.crit,
      unit: 'pcs',
      assignedAsset: p.on.map((tag) => assetByTag[tag]?._id).filter(Boolean),
      plantId: plant0,
    }),
  );
  await bulkInsert('spareparts', parts, now);
  const lots = bp.SPARE_PARTS.map((p, i) =>
    tenant({
      _id: id(`lot:${p.no}`),
      sparePartId: parts[i]._id,
      batchNo: `LOT-${p.no}-${rng.int(100, 999)}`,
      stockQuantity: p.stock,
      cost: p.cost,
      supplier: supplierByCode[p.supplier]._id,
      leadTime: bp.SUPPLIERS.find((s) => s.code === p.supplier).lead,
      purchaseDate: new Date(now - rng.int(20, 120) * DAY),
      location: `Store rack ${String.fromCharCode(65 + (i % 6))}${(i % 4) + 1}`,
    }),
  );
  await bulkInsert('sparepartinventories', lots, now);
  const lotByPart = new Map(lots.map((l) => [String(l.sparePartId), l]));

  const consumables = bp.CONSUMABLES.map((c) =>
    tenant({ _id: id(`consumable:${c.name}`), name: c.name, unit: c.unit, price: c.price, plantId: plant0 }),
  );
  await bulkInsert('consumables', consumables, now);

  // ── PM & calibration schedules ────────────────────────────────────────────
  const seqs = new Map(); // `${plantId}:${type}` → last number used
  const nextCode = (plantId, type, prefix) => {
    const key = `${plantId}:${type}`;
    const n = (seqs.get(key) ?? 0) + 1;
    seqs.set(key, n);
    return `${prefix}${n}`;
  };
  /** Same calendar day in IST, at `hour`:00 IST. */
  const atHour = (date, hour) => {
    const IST = 5.5 * HOUR;
    const local = new Date(new Date(date).getTime() + IST);
    local.setUTCHours(hour, 0, 0, 0);
    return new Date(local.getTime() - IST);
  };

  const pms = [];
  for (const [tag, dueInDays, duration] of bp.PM_SCHEDULE) {
    const asset = assetByTag[tag];
    if (!asset) continue;
    const next = atHour(new Date(now.getTime() + dueInDays * DAY), 9);
    pms.push(
      tenant({
        _id: id(`pm:${tag}`),
        preventiveMaintenanceId: nextCode(asset.plantId, 'PreventiveMaintenance', 'PM-'),
        name: `Monthly PM – ${asset.name}`,
        assetAllocation: asset._id,
        plantId: asset.plantId,
        estimatedDurationMin: duration,
        nextGenerationDate: next,
        lastMaintenanceDate: new Date(next.getTime() - 30 * DAY),
        schedule: { startDate: new Date(now - 180 * DAY) },
        trigger: { scheduleType: 'Regular', cycle: { everyNumber: 1, duration: 'Months' } },
        selectWorkOrder: {
          name: `Monthly PM – ${asset.name}`,
          priority: 'Medium',
          people: techsOf(asset.plantId)
            .slice(0, 1)
            .map((u) => u._id),
          taskAndChecklist: [
            {
              topic: 'PM checklist',
              tasks: (bp.PM_TASKS[asset.typeOfAsset] ?? []).map((task) => ({ task })),
            },
          ],
          dueDuration: { value: 2, unit: 'Days' },
        },
        createdBy: owner._id,
      }),
    );
  }
  await bulkInsert('preventivemaintenances', pms, now);

  const calibrations = [];
  for (const [calName, tag, everyMonths, dueInDays] of bp.CALIBRATIONS) {
    const asset = assetByTag[tag];
    if (!asset) continue;
    const next = atHour(new Date(now.getTime() + dueInDays * DAY), 10);
    calibrations.push(
      tenant({
        _id: id(`cal:${calName}`),
        calibrationId: nextCode(asset.plantId, 'Calibration', 'CAL-'),
        name: calName,
        assetAllocation: asset._id,
        plantId: asset.plantId,
        estimatedDurationMin: 45,
        nextGenerationDate: next,
        lastMaintenanceDate: new Date(next.getTime() - everyMonths * 30 * DAY),
        trigger: { scheduleType: 'Regular', cycle: { everyNumber: everyMonths, duration: 'Months' } },
        selectWorkOrder: { name: calName, priority: 'Medium', dueDuration: { value: 3, unit: 'Days' } },
        createdBy: owner._id,
      }),
    );
  }
  await bulkInsert('calibrations', calibrations, now);

  // ── Work orders (60 days of history per plant) ────────────────────────────
  const workOrders = [];
  const transactions = [];
  const comment = (user, text, at, type = 'automate') => ({ user, type, comment: text, createdAt: at });
  const repairTasks = [
    'Isolate machine (LOTO)',
    'Diagnose and repair',
    'Trial run and hand over to production',
  ];

  plants.forEach((plant, plantIndex) => {
    const count = plantIndex === 0 ? 64 : 12;
    const plantAssets = assets.filter(
      (a) => String(a.plantId) === String(plant._id) && a.typeOfAsset !== 'Energy Meter',
    );
    const techs = techsOf(plant._id).length ? techsOf(plant._id) : techsOf(plants[0]._id);
    if (!plantAssets.length) return;

    for (let i = 1; i <= count; i++) {
      const special = plantIndex === 0 && i === 42;
      const createdAt = special
        ? new Date(now - 26 * HOUR)
        : new Date(now - (60 - (i / count) * 59) * DAY + rng.int(0, 10) * HOUR);
      const asset = special ? (assetByTag['PRS-02'] ?? plantAssets[0]) : rng.pick(plantAssets);
      const category = special ? 'Mechanical' : weightedPick(rng, bp.WO_CATEGORY_WEIGHTS);
      const title = special
        ? 'Replace worn flywheel bearing'
        : category === 'Preventive'
          ? `Monthly PM – ${asset.name}`
          : rng.pick(bp.WO_TITLES[asset.typeOfAsset] ?? ['General inspection']);
      const ageDays = (now - createdAt) / DAY;
      let status;
      if (special) status = 'In Progress';
      else if (ageDays > 6) status = rng.chance(0.07) ? 'Open' : rng.chance(0.7) ? 'Closed' : 'Completed';
      else status = rng.pick(['Open', 'Open', 'In Progress', 'On Hold', 'Completed']);
      const priority =
        category === 'Breakdown'
          ? weightedPick(rng, [
              ['High', 6],
              ['Medium', 3],
              ['Low', 1],
            ])
          : weightedPick(rng, [
              ['High', 2],
              ['Medium', 5],
              ['Low', 3],
            ]);
      const dueDate = new Date(createdAt.getTime() + { High: 1, Medium: 3, Low: 7 }[priority] * DAY);
      const tech = special ? (userByKey.maintenance_technician_1 ?? techs[0]) : rng.pick(techs);
      const people = rng.chance(0.25) && techs.length > 1 ? [tech._id, rng.pick(techs)._id] : [tech._id];
      const uniquePeople = [...new Set(people.map(String))].map((p) => people.find((x) => String(x) === p));

      const started = status !== 'Open';
      const startedAt = new Date(createdAt.getTime() + (special ? 6 : rng.int(1, 6)) * HOUR);
      const workSec = rng.int(1, 8) * 3600 + rng.int(0, 59) * 60;
      const done = status === 'Completed' || status === 'Closed';
      const completedAt = new Date(startedAt.getTime() + workSec * 1000);
      const closedAt = new Date(completedAt.getTime() + rng.int(2, 20) * HOUR);

      const workOrderId = `WO-${i}`;
      const _id = id(`wo:${plant.plantCode}:${i}`);
      const tasks = (
        category === 'Preventive' ? (bp.PM_TASKS[asset.typeOfAsset] ?? repairTasks) : repairTasks
      ).map((task) => ({
        task,
        completed: done || special,
        ...(done || special ? { checkedBy: tech._id, checkedAt: done ? completedAt : now } : {}),
      }));

      const spareParts = [];
      if (
        done &&
        ['Breakdown', 'Mechanical', 'Hydraulic', 'Electrical'].includes(category) &&
        rng.chance(0.5)
      ) {
        const candidates = parts.filter((p) => p.assignedAsset.some((a) => String(a) === String(asset._id)));
        const pool = candidates.length ? candidates : parts;
        for (const part of [rng.pick(pool)]) {
          const qty = rng.int(1, 2);
          spareParts.push({
            sparePart: part._id,
            plannedQuantity: qty,
            consumedQuantity: qty,
            consumedAt: completedAt,
          });
          const lot = lotByPart.get(String(part._id));
          transactions.push(
            tenant({
              sparePartId: part._id,
              inventoryId: lot._id,
              type: 'used',
              quantity: qty,
              unitCost: lot.cost,
              reason: { manual: `Used on ${workOrderId}`, workOrderId: _id },
              actionPerformedBy: tech._id,
              createdAt: completedAt,
            }),
          );
        }
      }

      const comments = [comment(tech._id, 'Created the work order.', createdAt)];
      if (started) comments.push(comment(tech._id, 'Started the work order.', startedAt));
      if (status === 'On Hold')
        comments.push(comment(tech._id, 'Put the work order on hold.', new Date(startedAt.getTime() + HOUR)));
      if (done) comments.push(comment(tech._id, 'Completed the work order.', completedAt));
      if (status === 'Closed') comments.push(comment(owner._id, 'Closed the work order.', closedAt));

      const onHoldAt = new Date(startedAt.getTime() + HOUR);
      workOrders.push(
        tenant({
          _id,
          workOrderId,
          name: title,
          description: special
            ? 'Flywheel bearing noise reported by the press operator. Bearing replaced; checking run-out before hand-over.'
            : `${title} on ${asset.name}.`,
          asset: asset._id,
          plantId: plant._id,
          priority,
          category,
          workStatus: status,
          scheduleType: category === 'Preventive' ? 'Time Based' : 'Manual',
          people: uniquePeople,
          dueDate,
          estimatedDurationMin: Math.round(workSec / 60),
          spareParts,
          consumablesAndTools:
            rng.chance(0.4) && consumables.length
              ? [{ consumable: consumables[0]._id, quantity: rng.int(1, 2) }]
              : [],
          taskAndChecklist: [{ topic: category === 'Preventive' ? 'PM checklist' : 'Repair', tasks }],
          authorizationType: 'Digital Signature',
          rating: status === 'Closed' ? rng.int(3, 5) : undefined,
          closedBy: status === 'Closed' ? owner._id : undefined,
          trackProcess: {
            openedAt: createdAt,
            startedAt: started ? startedAt : undefined,
            inProgressAt: status === 'In Progress' ? startedAt : undefined,
            onHoldAt: status === 'On Hold' ? onHoldAt : undefined,
            completedAt: done ? completedAt : undefined,
            closedAt: status === 'Closed' ? closedAt : undefined,
            reOpenProcess: [],
          },
          durations: {
            timeInProgress: secondsToHms(done ? workSec : status === 'On Hold' ? 3600 : 0),
            timeOnHold: '00:00:00',
          },
          pauseHistory: status === 'On Hold' ? [{ pausedAt: onHoldAt, pausedBy: tech._id }] : [],
          comments,
          createdBy: tech._id,
          lastModifiedBy: tech._id,
          createdAt,
          updatedAt: done ? (status === 'Closed' ? closedAt : completedAt) : createdAt,
        }),
      );
      seqs.set(`${plant._id}:WorkOrder`, i);
    }
  });
  await bulkInsert('workorders', workOrders, now);
  await bulkInsert('sparepartstransactions', transactions, now);

  // Maintenance requests: the first breakdowns of the main plant came in as requests.
  const requestable = workOrders
    .filter((w) => String(w.plantId) === String(plant0) && w.category === 'Breakdown')
    .slice(0, 8);
  const requests = requestable.map((wo, k) =>
    tenant({
      _id: id(`request:${k + 1}`),
      requestId: nextCode(plant0, 'Request', 'MR-'),
      name: wo.name,
      description: `Raised by production: ${wo.name.toLowerCase()}.`,
      type: 'Breakdown',
      allocationType: 'Asset',
      asset: wo.asset,
      plantId: plant0,
      status: ['Completed', 'Closed'].includes(wo.workStatus) ? 'Close' : 'Open',
      workOrder: wo._id,
      comments: [comment(wo.createdBy, 'Opened the request.', wo.createdAt)],
      createdBy: productionCrew[0]?._id ?? owner._id,
      createdAt: new Date(wo.createdAt.getTime() - 15 * 60_000),
    }),
  );
  await bulkInsert('requests', requests, now);
  await Promise.all(
    requests.map((r) =>
      Model('workorders').collection.updateOne({ _id: r.workOrder }, { $set: { requestId: r._id } }),
    ),
  );

  // ── Production ────────────────────────────────────────────────────────────
  const jobCards = [];
  if (features.productionEnabled) {
    const toolSpecs = bp.TOOLS.filter((t) => t.assets.some((tag) => assetByTag[tag]));
    const tools = toolSpecs.map((t) =>
      tenant({
        _id: id(`tool:${t.no}`),
        name: t.name,
        toolNumber: t.no,
        status: 'In Service',
        mouldParts: t.parts.map((p) => ({ ...p, _id: id(`tool:${t.no}:part:${p.partName}`) })),
        assets: t.assets.map((tag) => assetByTag[tag]?._id).filter(Boolean),
        idealCycleTimeSec: t.cycle,
        setupTimeMin: t.setup,
        shotCount: rng.int(80_000, 600_000),
        maxShotLife: 1_000_000,
        manufacturer: 'In-house tool room',
        plantId: assetByTag[t.assets.find((tag) => assetByTag[tag])].plantId,
      }),
    );
    await bulkInsert('tools', tools, now);
    const toolByNo = Object.fromEntries(toolSpecs.map((t, i) => [t.no, tools[i]]));

    const customers = bp.CUSTOMERS.map((c) =>
      tenant({
        _id: id(`customer:${c.code}`),
        name: c.name,
        customerCode: c.code,
        contactPerson: c.contact,
        email: `purchase@${slugify(c.name)}.example.com`,
        addresses: [{ addressType: 'Shipping', city: c.city, country: 'India' }],
        plantId: plant0,
      }),
    );
    await bulkInsert('customers', customers, now);
    const customerByCode = Object.fromEntries(bp.CUSTOMERS.map((c, i) => [c.code, customers[i]]));

    const plans = bp.PRODUCTION_PLANS.filter(([, , , , toolNo]) => toolByNo[toolNo]).map(
      ([partName, quantity, cust, dueIn, toolNo, status]) =>
        tenant({
          _id: id(`plan:${partName}`),
          reqId: nextCode(plant0, 'ProductionPlan', 'PP-'),
          partName,
          quantity,
          customer: customerByCode[cust]._id,
          tool: toolByNo[toolNo]._id,
          dueDate: atHour(new Date(now.getTime() + dueIn * DAY), 18),
          status,
          priority: dueIn <= 7 ? 'High' : 'Medium',
          plantId: plant0,
          createdBy: userByKey.production_manager_1?._id ?? owner._id,
          createdAt: new Date(now - 12 * DAY),
        }),
    );
    await bulkInsert('productionplans', plans, now);
    const planByPart = Object.fromEntries(plans.map((p) => [p.partName, p]));

    const operationName = (asset) =>
      ({ 'Injection Moulding Machine': 'Moulding', 'Power Press': 'Pressing', 'CNC Machine': 'Machining' })[
        asset.typeOfAsset
      ] ?? 'Processing';

    const makeJob = ({ seq, toolNo, tag, status, startDays, durationDays, target }) => {
      const tool = toolByNo[toolNo];
      const asset = assetByTag[tag];
      if (!tool || !asset) return null;
      const part = tool.mouldParts[0];
      const plan = planByPart[part.partName];
      const start = new Date(now.getTime() + startDays * DAY);
      const end = new Date(start.getTime() + durationDays * DAY);
      const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
      const done = status === 'Completed';
      const produced = Math.round(
        done ? target * rng.float(0.98, 1.03) : status === 'In Progress' ? target * elapsed : 0,
      );
      const ng = Math.round(produced * rng.float(0.01, 0.04));
      const availability = rng.float(0.78, 0.92);
      const performance = rng.float(0.82, 0.95);
      const quality = produced ? (produced - ng) / produced : 1;
      return tenant({
        _id: id(`jc:${seq}`),
        jobCardId: `JC-${seq}`,
        jobName: `${part.partName} – ${customers.find((c) => String(c._id) === String(plan?.customer))?.name ?? 'stock'}`,
        asset: asset._id,
        plantId: asset.plantId,
        tool: tool._id,
        productionPlanId: plan?._id,
        partName: part.partName,
        target,
        idealCycleTime: tool.idealCycleTimeSec,
        jobStatus: status,
        startDate: start,
        endDate: end,
        actualStart: status === 'Open' ? undefined : start,
        actualEnd: done ? end : undefined,
        assignedTo: productionCrew.slice(0, 2).map((u) => u._id),
        rejectionPercentage: 2,
        totalShotCount: Math.round(produced / part.partPerShot),
        mouldParts: [
          {
            partNameId: String(part._id),
            partName: part.partName,
            assignedPartPerShot: part.partPerShot,
            partWeightKg: part.partWeight / 1000,
          },
        ],
        operations: [
          {
            operationName: operationName(asset),
            assetId: asset._id,
            cycleTime: tool.idealCycleTimeSec,
            isOperationDone: done,
            progress: { partsIn: 0, partsRejected: ng, partsOut: produced - ng },
          },
        ],
        completionMetrics: done
          ? {
              productionSummary: { okParts: produced - ng, ngParts: ng, totalPartsProduced: produced },
              oee: {
                oee: +(availability * performance * quality).toFixed(3),
                availability: +availability.toFixed(3),
                performance: +performance.toFixed(3),
                quality: +quality.toFixed(3),
              },
              timeAndEfficiency: {
                jobDurationSec: Math.round((end - start) / 1000),
                avgCycleTimeSec: +(tool.idealCycleTimeSec / performance).toFixed(1),
                downtimeSec: Math.round(((end - start) / 1000) * (1 - availability)),
              },
            }
          : undefined,
        createdBy: userByKey.production_manager_1?._id ?? owner._id,
        createdAt: new Date(start.getTime() - DAY),
      });
    };

    // Completed history: one job every 3.5 days, rotating tools on their first eligible machine.
    const rotation = [
      'T-101',
      'T-201',
      'T-301',
      'T-302',
      'T-401',
      'T-102',
      'T-201',
      'T-301',
      'T-101',
      'T-302',
      'T-102',
    ];
    rotation.forEach((toolNo, k) => {
      const spec = bp.TOOLS.find((t) => t.no === toolNo);
      const tag = spec?.assets.find((t) => assetByTag[t]);
      const target = { 'T-401': 300, 'T-301': 18000, 'T-302': 24000, 'T-201': 30000 }[toolNo] ?? 7000;
      const job = makeJob({
        seq: k + 1,
        toolNo,
        tag,
        status: 'Completed',
        startDays: -45 + k * 3.6,
        durationDays: 2.5,
        target,
      });
      if (job) jobCards.push(job);
    });
    for (const live of [
      {
        seq: 12,
        toolNo: 'T-101',
        tag: 'IMM-01',
        status: 'In Progress',
        startDays: -2,
        durationDays: 3.5,
        target: 6000,
      },
      {
        seq: 13,
        toolNo: 'T-201',
        tag: 'IMM-02',
        status: 'In Progress',
        startDays: -1,
        durationDays: 3.5,
        target: 24000,
      },
      {
        seq: 14,
        toolNo: 'T-101',
        tag: 'IMM-01',
        status: 'Open',
        startDays: 1.6,
        durationDays: 2.5,
        target: 6000,
      },
      {
        seq: 15,
        toolNo: 'T-301',
        tag: 'PRS-01',
        status: 'In Progress',
        startDays: -1,
        durationDays: 2,
        target: 15000,
      },
      {
        seq: 16,
        toolNo: 'T-401',
        tag: 'CNC-03',
        status: 'Open',
        startDays: 0.5,
        durationDays: 2.5,
        target: 200,
      },
    ]) {
      const job = makeJob(live);
      if (job) jobCards.push(job);
    }
    await bulkInsert('jobcards', jobCards, now);
    seqs.set(`${plant0}:JobCard`, 16);
    for (const jc of jobCards.filter((j) => j.jobStatus === 'In Progress')) {
      await Model('assets').collection.updateOne({ _id: jc.asset }, { $set: { jobCard: jc._id } });
    }
  }

  // ── Optional telemetry-derived history ─────────────────────────────────────
  if (withHistory) {
    const downtimes = [];
    const productionAssets = assets.filter((a) => a.isProductionAsset);
    for (const asset of productionAssets) {
      for (let k = 0; k < 3; k++) {
        const startedAt = new Date(now - rng.int(1, 14) * DAY - rng.int(0, 20) * HOUR);
        const seconds = rng.int(10, 95) * 60;
        const endedAt = new Date(startedAt.getTime() + seconds * 1000);
        const reason = rng.chance(0.75) ? [rng.pick(bp.DOWNTIME_REASONS)] : [];
        downtimes.push(
          tenant({
            assetId: asset._id,
            plantId: asset.plantId,
            startedAt,
            endedAt,
            totalDowntimeInSeconds: seconds,
            states: [{ status: 'Stopped', start: startedAt, end: endedAt }],
            reason,
            reasonText: reason.join(', '),
            requiresVerification: seconds > 600,
            isVerified: reason.length > 0,
            createdAt: endedAt,
          }),
        );
      }
    }
    await bulkInsert('downtimes', downtimes, now);

    const rejections = [];
    for (const job of jobCards.filter((j) => j.jobStatus !== 'Open')) {
      const ng = job.operations[0].progress.partsRejected;
      for (let k = 0; k < 3 && ng > 0; k++) {
        rejections.push(
          tenant({
            partName: job.partName,
            assetId: job.asset,
            jobCardId: job._id,
            plantId: job.plantId,
            rejectionReason: rng.pick(REJECTION_REASONS.slice(0, 6)),
            rejectedCount: Math.max(1, Math.round(ng / 3)),
            origin: 'machine',
            rejectedBy: userByKey.quality_inspector_1?._id,
            createdAt: new Date(
              Math.min(now, job.startDate.getTime() + rng.float(0.1, 0.9) * (job.endDate - job.startDate)),
            ),
          }),
        );
      }
    }
    await bulkInsert('rejections', rejections, now);
  }

  // ── Counters & welcome ────────────────────────────────────────────────────
  const counterDocs = [...seqs].map(([key, seq]) => {
    const [plantId, type] = key.split(':');
    return { companyId, plantId: plants.find((p) => String(p._id) === plantId)?._id ?? null, type, seq };
  });
  await Counter.insertMany(counterDocs);
  await bulkInsert(
    'notifications',
    [
      tenant({
        plantId: null,
        message: {
          title: `Welcome to SARA, ${name}`,
          description:
            'Ask SARA anything about your plant: machines, maintenance, production, costs and KPIs.',
        },
        type: 'success',
        priority: 'low',
        recipientUsers: [owner._id],
      }),
    ],
    now,
  );

  return {
    companyId,
    name,
    slug,
    credentials: users.map((u) => ({
      email: u.email,
      password,
      name: `${u.firstName} ${u.lastName}`,
      role: u.role,
      title: u.userTitle,
      plant: plants.find((p) => String(p._id) === String(u.plantId))?.name ?? 'All plants',
    })),
    counts: {
      plants: plants.length,
      users: users.length,
      assets: assets.length,
      workOrders: workOrders.length,
      jobCards: jobCards.length,
    },
  };
};
