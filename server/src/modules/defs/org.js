import bcrypt from 'bcryptjs';
import { badRequest, forbidden } from '../../lib/errors.js';
import { assertGrantable, canManageUser, PERMISSION_KEYS, ROLES } from '../permissions.js';

const HHMM = { pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', patternMessage: 'use 24-hour HH:mm' };
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const permissionFields = Object.fromEntries(
  PERMISSION_KEYS.map((key) => [
    key,
    {
      type: 'object',
      fields: {
        add: { type: 'boolean', default: false },
        update: { type: 'boolean', default: false },
        delete: { type: 'boolean', default: false },
      },
    },
  ]),
);

const userHooks = {
  beforeCreate: async ({ ctx, doc }) => {
    assertGrantable(ctx, doc.role ?? 'technician');
    if (!doc.password) throw badRequest('A password is required for a new user');
    if (doc.password.length < 8) throw badRequest('Password must be at least 8 characters');
    doc.email = doc.email.toLowerCase();
    doc.password = await bcrypt.hash(doc.password, 10);
  },
  beforeUpdate: async ({ ctx, existing, patch }) => {
    if (!canManageUser(ctx, existing))
      throw forbidden(`Your role (${ctx.role}) can't edit a ${existing.role}`);
    if (patch.role && patch.role !== existing.role) {
      if (String(existing._id) === String(ctx.userId)) throw forbidden("You can't change your own role");
      assertGrantable(ctx, patch.role);
    }
    if (patch.email) patch.email = patch.email.toLowerCase();
    if (patch.password) {
      if (patch.password.length < 8) throw badRequest('Password must be at least 8 characters');
      patch.password = await bcrypt.hash(patch.password, 10);
    }
  },
};

export default [
  {
    name: 'companies',
    model: 'Company',
    label: 'Companies',
    singular: 'Company',
    group: 'Organisation',
    icon: 'Building2',
    description: 'The tenant account. Users only ever see their own company.',
    tenantField: '_id',
    softDelete: false,
    agentWritable: false,
    createRoles: ['superAdmin', 'system'],
    list: ['name', 'industry', 'location'],
    search: ['name'],
    fields: {
      name: { type: 'string', required: true },
      industry: { type: 'string' },
      location: { type: 'string' },
      companyEmail: { type: 'string' },
      companyPhoneNumber: { type: 'string' },
      companyContactPerson: { type: 'string' },
      domain: { type: 'string', readOnly: true, help: 'Email domain of the generated users' },
      isSimulated: { type: 'boolean', readOnly: true, default: false },
      isPlatform: { type: 'boolean', readOnly: true, hidden: true, default: false },
      subscription: {
        type: 'object',
        readOnly: true,
        fields: {
          status: { type: 'enum', values: ['trial', 'active', 'expired'], default: 'active' },
          currentPlan: {
            type: 'enum',
            values: ['free', 'basic', 'premium', 'enterprise'],
            default: 'enterprise',
          },
        },
      },
      features: {
        type: 'object',
        readOnly: true,
        fields: {
          productionEnabled: { type: 'boolean', default: true },
          energyEnabled: { type: 'boolean', default: true },
          binTrackingEnabled: { type: 'boolean', default: false },
          isMasterReportEnabled: { type: 'boolean', default: false },
        },
      },
      preferences: {
        type: 'object',
        fields: {
          timeZone: { type: 'string', default: 'Asia/Kolkata', help: 'IANA zone, e.g. Asia/Kolkata' },
          dateFormat: {
            type: 'enum',
            values: ['DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD'],
            default: 'DD-MM-YYYY',
          },
          timeFormat: { type: 'enum', values: ['12-hours', '24-hours'], default: '12-hours' },
          currency: {
            type: 'object',
            fields: { name: { type: 'string', default: 'INR' }, symbol: { type: 'string', default: '₹' } },
          },
        },
      },
      binStations: {
        type: 'array',
        label: 'Bin stations',
        of: { name: { type: 'string', required: true }, plantId: { type: 'ref', ref: 'plants' } },
      },
      billing: {
        type: 'object',
        fields: {
          street: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          country: { type: 'string' },
          zipCode: { type: 'string' },
          taxId: { type: 'string', label: 'Tax ID / GSTIN' },
        },
      },
      scheduleVersion: { type: 'number', default: 0, readOnly: true, hidden: true },
    },
  },
  {
    name: 'plants',
    model: 'Plant',
    label: 'Plants',
    group: 'Organisation',
    icon: 'Factory',
    description: 'Plants, their shifts, running days, holidays and energy tariffs.',
    agentNotes:
      'Shift times are HH:mm; end ≤ start means the shift ends next day. Tariffs in ₹/kWh by validity window.',
    permissionKey: 'plant',
    codeField: 'plantCode',
    list: ['plantCode', 'name', 'location'],
    search: ['name', 'plantCode', 'location'],
    fields: {
      name: { type: 'string', required: true },
      plantCode: { type: 'string' },
      location: { type: 'string' },
      pointOfContact: { type: 'string' },
      plantContactNumber: { type: 'string' },
      email: { type: 'string' },
      shifts: {
        type: 'array',
        of: {
          shiftName: { type: 'string', required: true },
          shiftStartTime: { type: 'string', required: true, ...HHMM },
          shiftEndTime: { type: 'string', required: true, ...HHMM },
          breaks: {
            type: 'array',
            of: {
              breakType: { type: 'string' },
              breakStartTime: { type: 'string', ...HHMM },
              breakEndTime: { type: 'string', ...HHMM },
            },
          },
        },
      },
      runningSchedule: { type: 'array', of: { type: 'enum', values: WEEKDAYS }, label: 'Running days' },
      holidays: {
        type: 'array',
        of: { date: { type: 'date', required: true }, description: { type: 'string' } },
      },
      energyData: {
        type: 'object',
        label: 'Energy',
        fields: {
          energyCostHistory: {
            type: 'array',
            label: 'Tariffs',
            of: {
              value: { type: 'number', required: true, unit: '₹/kWh' },
              addedDate: { type: 'date', required: true, label: 'Valid from' },
              changedDate: { type: 'date', label: 'Valid until' },
              deleted: { type: 'boolean', default: false },
            },
          },
          energyEmissionHistory: {
            type: 'array',
            label: 'Emission factors',
            of: { value: { type: 'number', required: true, unit: 'kg CO₂/kWh' }, date: { type: 'date' } },
          },
        },
      },
    },
  },
  {
    name: 'users',
    model: 'User',
    label: 'People',
    singular: 'Person',
    group: 'Organisation',
    icon: 'Users',
    description: 'Everyone who uses SARA in your company, with their role and permissions.',
    agentNotes: 'Roles: owner, admin, technician (per-module permissions), view (read only).',
    plantScoped: true,
    agentWritable: false,
    titleField: 'firstName',
    list: ['firstName', 'lastName', 'email', 'role', 'department', 'userTitle'],
    search: ['firstName', 'lastName', 'email', 'employeeId', 'userTitle'],
    sort: 'firstName',
    indexes: [[{ email: 1 }, { unique: true }]],
    hooks: userHooks,
    fields: {
      firstName: { type: 'string', required: true },
      lastName: { type: 'string' },
      email: { type: 'string', required: true, email: true, lowercase: true },
      password: { type: 'string', secret: true, label: 'Password', help: 'At least 8 characters' },
      phoneNumber: { type: 'string' },
      employeeId: { type: 'string', label: 'Employee ID' },
      role: { type: 'enum', values: ROLES, default: 'technician' },
      department: { type: 'enum', values: ['Maintenance', 'Production'], default: 'Maintenance' },
      userTitle: { type: 'string', label: 'Job title' },
      skills: { type: 'tags', help: 'e.g. electrical, hydraulics, moulding' },
      shiftId: { type: 'string', label: 'Shift', help: 'Id of a plant shift' },
      status: { type: 'enum', values: ['available', 'busy'], default: 'available' },
      permissions: { type: 'object', fields: permissionFields, help: 'Technician permissions per module' },
      lastLogin: { type: 'date', readOnly: true },
    },
  },
  {
    name: 'usergroups',
    model: 'UserGroup',
    label: 'Teams',
    singular: 'Team',
    group: 'Organisation',
    icon: 'UsersRound',
    description: 'Teams of people that work orders can be assigned to.',
    plantScoped: true,
    list: ['name', 'description', 'members'],
    fields: {
      name: { type: 'string', required: true },
      description: { type: 'text' },
      members: { type: 'refs', ref: 'users' },
      tags: { type: 'tags' },
    },
  },
  {
    name: 'costsettings',
    model: 'CostSettings',
    label: 'Cost Settings',
    singular: 'Cost settings',
    group: 'Costs',
    icon: 'Settings2',
    description: 'Rates the cost model uses: labour per hour and the cost of an hour of machine downtime.',
    agentNotes: 'One record per company; update it instead of creating another.',
    softDelete: false,
    titleField: 'label',
    list: ['label', 'laborRatePerHour', 'defaultDowntimeCostPerHour'],
    search: ['label'],
    singleton: true,
    fields: {
      label: { type: 'string', default: 'Cost settings' },
      laborRatePerHour: { type: 'number', min: 0, default: 350, unit: '₹/h', label: 'Labour rate' },
      defaultDowntimeCostPerHour: {
        type: 'number',
        min: 0,
        default: 2500,
        unit: '₹/h',
        label: 'Downtime cost',
      },
      monthlyMaintenanceBudget: { type: 'number', min: 0, unit: '₹', label: 'Monthly maintenance budget' },
      monthlyEnergyBudget: { type: 'number', min: 0, unit: '₹', label: 'Monthly energy budget' },
      notes: { type: 'text' },
    },
  },
];
