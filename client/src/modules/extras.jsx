import { MaintenancePlanChain, ProductionPlanChain } from './PlanChain.jsx';

/** Module-specific sections the record page renders above the related records. */
export const RECORD_EXTRAS = { productionplans: ProductionPlanChain, maintenanceplans: MaintenancePlanChain };

/** Fields those sections already show (with provenance), so the generic field cards skip them. */
export const EXTRA_COVERS = { productionplans: ['aiSummary'], maintenanceplans: ['aiSummary', 'metrics'] };

/** Child relations those sections already list (with an Add button), so Related skips their tabs. */
export const EXTRA_CHILDREN = { productionplans: ['jobcards'], maintenanceplans: ['workorders'] };
