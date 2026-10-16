/** Bin tracking (CMMS binModel / binSessionModel / stationPoolModel, simplified): only for companies with binTrackingEnabled. */
const BINS = {
  feature: 'binTrackingEnabled',
  permissionKey: 'production',
  group: 'Bins & stations',
  plantScoped: true,
};
const BIN_EVENTS = ['fill', 'in', 'out', 'rejection', 'swap', 'dispatch', 'return'];
export const BIN_SIZES = ['Small crate', 'Medium crate', 'Large crate', 'Pallet box'];

export default [
  {
    ...BINS,
    name: 'bins',
    model: 'Bin',
    label: 'Bins',
    icon: 'Package',
    description: 'RFID-tagged bins that carry parts from the machines through the stations to dispatch.',
    agentNotes:
      'binRfId is the RFID tag (unique per company). status is where the bin is: In (store), Out (on the floor), Lost, Broken. productionStatus is what it holds.',
    titleField: 'binRfId',
    list: ['binRfId', 'binSizeType', 'status', 'productionStatus', 'currentPartName', 'station'],
    search: ['binRfId', 'currentPartName', 'station.name'],
    sort: 'binRfId',
    indexes: [
      [
        { companyId: 1, binRfId: 1 },
        { unique: true, partialFilterExpression: { deleted: false } },
      ],
    ],
    fields: {
      binRfId: { type: 'string', required: true, label: 'RFID tag' },
      binSizeType: { type: 'string', required: true, suggestions: BIN_SIZES, label: 'Size' },
      status: {
        type: 'enum',
        values: ['In', 'Out', 'Lost', 'Broken'],
        default: 'In',
        help: 'In = in the store',
      },
      productionStatus: {
        type: 'enum',
        values: ['Empty', 'In Production', 'Completed', 'Dispatched'],
        default: 'Empty',
        label: 'Contents',
      },
      currentPartName: { type: 'string', label: 'Current part' },
      jobCardId: { type: 'ref', ref: 'jobcards', label: 'Current job card' },
      station: {
        type: 'object',
        label: 'Last scan',
        fields: { name: { type: 'string', label: 'Station' }, scannedAt: { type: 'date' } },
      },
      dispatchedAt: { type: 'date' },
      history: {
        type: 'array',
        readOnly: true,
        rowIds: false,
        maxItems: 200,
        of: {
          event: { type: 'enum', values: BIN_EVENTS, required: true },
          at: { type: 'date' },
          stationName: { type: 'string' },
          partName: { type: 'string' },
          qty: { type: 'number', min: 0 },
          jobCardId: { type: 'ref', ref: 'jobcards' },
          byUser: { type: 'ref', ref: 'users' },
        },
      },
    },
  },
  {
    ...BINS,
    name: 'binsessions',
    model: 'BinSession',
    label: 'Bin Sessions',
    singular: 'Bin session',
    icon: 'Boxes',
    description:
      'One fill of a bin: the job card and machine the parts came from, how many, and where they are now.',
    agentNotes:
      'stationState: at_machine → in_process (pooled at a station) → prepared → dispatched. binPartCount = parts in the bin now.',
    titleField: 'partName',
    list: ['binId', 'partName', 'jobCardId', 'assetId', 'stationState', 'binPartCount', 'updatedAt'],
    search: ['partName', 'currentStation.stationName'],
    sort: '-updatedAt',
    inheritPlantFrom: ['assetId'],
    fields: {
      binId: { type: 'ref', ref: 'bins', label: 'Bin' },
      jobCardId: { type: 'ref', ref: 'jobcards', label: 'Job card' },
      assetId: { type: 'ref', ref: 'assets', label: 'Machine' },
      partName: { type: 'string', required: true, label: 'Part' },
      stationState: {
        type: 'enum',
        values: ['at_machine', 'in_process', 'prepared', 'dispatched'],
        default: 'at_machine',
        label: 'Stage',
      },
      currentStation: {
        type: 'object',
        label: 'Current station',
        fields: { stationName: { type: 'string', label: 'Station' }, since: { type: 'date' } },
      },
      binPartCount: { type: 'number', min: 0, default: 0, unit: 'pcs', label: 'Parts in bin' },
      dispatchedAt: { type: 'date' },
      history: {
        type: 'array',
        readOnly: true,
        rowIds: false,
        maxItems: 200,
        of: {
          event: { type: 'enum', values: BIN_EVENTS, required: true },
          at: { type: 'date' },
          stationName: { type: 'string' },
          qty: { type: 'number', min: 0 },
          userId: { type: 'ref', ref: 'users', label: 'By' },
        },
      },
    },
  },
  {
    ...BINS,
    name: 'stationpools',
    model: 'StationPool',
    label: 'Station Pools',
    singular: 'Station pool',
    icon: 'Layers',
    description:
      'Parts gathered at a station (inspection, assembly, packing) for one job card before they are packed into bins.',
    agentNotes:
      'Parts available at the station = qtyIn − qtyRejected − qtyOut. status: open → drained → closed.',
    titleField: 'stationName',
    list: ['stationName', 'partName', 'jobCardId', 'status', 'qtyIn', 'qtyRejected', 'qtyOut'],
    search: ['stationName', 'partName'],
    sort: '-updatedAt',
    inheritPlantFrom: ['stationAssetId'],
    fields: {
      stationName: { type: 'string', required: true, label: 'Station' },
      stationAssetId: { type: 'ref', ref: 'assets', label: 'Station machine' },
      jobCardId: { type: 'ref', ref: 'jobcards', label: 'Job card' },
      partName: { type: 'string', label: 'Part' },
      partsPerBin: { type: 'number', min: 1, unit: 'pcs' },
      binSizeType: { type: 'string', suggestions: BIN_SIZES, label: 'Bin size' },
      status: { type: 'enum', values: ['open', 'drained', 'closed'], default: 'open' },
      qtyIn: { type: 'number', min: 0, default: 0, unit: 'pcs', label: 'In' },
      qtyRejected: { type: 'number', min: 0, default: 0, unit: 'pcs', label: 'Rejected' },
      qtyOut: { type: 'number', min: 0, default: 0, unit: 'pcs', label: 'Out' },
      openedAt: { type: 'date' },
      lastActivityAt: { type: 'date', label: 'Last activity' },
      drainedAt: { type: 'date' },
    },
  },
];
