const HMS = { pattern: '^\\d{2,}:[0-5]\\d:[0-5]\\d$', patternMessage: 'use HH:MM:SS' };

/** Who came to work and when, plus their breaks (written by the attendance devices; CMMS checkinouts/userbreaktimes). */
const attendance = {
  group: 'Organisation',
  plantScoped: true,
  softDelete: false,
  agentWritable: false,
};

export default [
  {
    ...attendance,
    name: 'checkinouts',
    model: 'CheckInOut',
    label: 'Attendance',
    icon: 'CalendarClock',
    description: 'Check-ins and check-outs per person and shift.',
    agentNotes: 'One record per person per shift worked; checkOutTime is empty while they are still in.',
    titleField: 'shiftName',
    list: ['userId', 'shiftName', 'checkInTime', 'checkOutTime', 'duration'],
    search: ['shiftName'],
    dateField: 'checkInTime',
    sort: '-checkInTime',
    indexes: [[{ companyId: 1, userId: 1, checkInTime: -1 }]],
    fields: {
      userId: { type: 'ref', ref: 'users', required: true, label: 'Person' },
      shiftName: { type: 'string', label: 'Shift' },
      checkInTime: { type: 'date', required: true, label: 'Checked in' },
      checkOutTime: { type: 'date', label: 'Checked out' },
      duration: { type: 'string', readOnly: true, ...HMS, help: 'HH:MM:SS between check-in and check-out' },
    },
  },
  {
    ...attendance,
    name: 'userbreaktimes',
    model: 'UserBreakTime',
    label: 'Breaks',
    icon: 'TimerOff',
    description: 'Tea and meal breaks taken during a shift.',
    titleField: 'breakType',
    list: ['userId', 'breakType', 'startTime', 'endTime', 'duration'],
    search: ['breakType'],
    dateField: 'startTime',
    sort: '-startTime',
    indexes: [[{ companyId: 1, userId: 1, startTime: -1 }]],
    fields: {
      userId: { type: 'ref', ref: 'users', required: true, label: 'Person' },
      checkInOutId: { type: 'ref', ref: 'checkinouts', label: 'Attendance' },
      breakType: { type: 'string', label: 'Break' },
      startTime: { type: 'date', required: true, label: 'Started' },
      endTime: { type: 'date', label: 'Ended' },
      duration: { type: 'string', readOnly: true, ...HMS, help: 'HH:MM:SS of the break' },
    },
  },
];
