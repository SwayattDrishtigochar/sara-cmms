export default [
  {
    name: 'notifications',
    model: 'Notification',
    label: 'Notifications',
    group: 'System',
    icon: 'Bell',
    description: 'In-app notifications: assignments, AI anomaly alerts, cost alerts.',
    plantScoped: true,
    softDelete: false,
    agentWritable: false,
    titleField: 'message.title',
    list: ['createdAt', 'message', 'type', 'priority'],
    search: ['message.title', 'message.description'],
    indexes: [[{ companyId: 1, createdAt: 1 }]], // live poller: new notifications
    fields: {
      message: {
        type: 'object',
        fields: { title: { type: 'string', required: true }, description: { type: 'text' } },
      },
      type: { type: 'enum', values: ['normal', 'success', 'alert'], default: 'normal' },
      priority: { type: 'enum', values: ['low', 'medium', 'high'], default: 'medium' },
      details: {
        type: 'object',
        fields: {
          module: { type: 'string' },
          recordId: { type: 'string' },
          assetId: { type: 'string' },
        },
      },
      recipientUsers: { type: 'refs', ref: 'users', label: 'Recipients' },
      readBy: { type: 'refs', ref: 'users', readOnly: true },
    },
  },
];
