import { SimControl } from '../db/models/Sim.js';
import { getModule } from '../modules/registry.js';

/**
 * The one company the simulator runs: the one `simcontrol.companyId` names, else the newest
 * company with `isSimulated`. Lean company doc, or null before the simulator's first run.
 */
export const simulatedCompany = async () => {
  const Company = getModule('companies').Model;
  const control = await SimControl.findById('default').select('companyId').lean();
  const pinned = control?.companyId
    ? await Company.findOne({ _id: control.companyId, isSimulated: true }).lean()
    : null;
  return pinned ?? Company.findOne({ isSimulated: true }).sort({ createdAt: -1, _id: -1 }).lean();
};
