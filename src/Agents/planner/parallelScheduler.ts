// Conceptual optimistic lock helper for workflow execution states
export interface WorkflowState {
  id: string;
  version: number;
  status: 'running' | 'recovered' | 'intervened';
  completedSteps: string[];
}

export class WorkflowConcurrencyEngine {
  private states = new Map<string, WorkflowState>();

  async executeAttempt(
    workflowId: string, 
    actor: 'recovery' | 'intervention', 
    sideEffectFn: () => Promise<void>
  ): Promise<boolean> {
    // Simulate concurrent check-and-set or version increment
    const state = this.states.get(workflowId) || {
      id: workflowId,
      version: 1,
      status: 'running',
      completedSteps: [],
    };

    if (state.status === 'recovered' || state.status === 'intervened') {
      return false; // Already handled by another concurrent actor
    }

    // Claim the attempt synchronously: there is no await between the status
    // check above and this write, so a concurrent caller cannot pass the
    // same check and run the side effect twice.
    state.status = actor === 'recovery' ? 'recovered' : 'intervened';
    state.version += 1;
    this.states.set(workflowId, state);

    try {
      await sideEffectFn();
      return true;
    } catch (error) {
      // Release the claim so a later attempt can retry the side effect.
      state.status = 'running';
      state.version -= 1;
      throw error;
    }
  }
}