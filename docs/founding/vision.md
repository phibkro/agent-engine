# Project Agent Runtime
## Vision and Constitution

**Status:** North Star  
**Purpose:** Preserve the project’s intent across implementations, contributors, and technological change.

---

# 1. Vision

Software projects are increasingly performed by a mixture of humans, AI agents, deterministic automation, and external systems.

Most current agent systems begin with the agent as the central abstraction:

> Give an agent a task, tools, memory, and a loop, then let it work.

This project begins somewhere else:

> **The Project is the durable system. Agents are participants in it.**

A Project should continue to exist coherently regardless of:

- which model performs the work;
- which harness executes it;
- whether a human or machine performs a role;
- whether an individual Session terminates;
- whether work happens sequentially or concurrently;
- whether infrastructure providers change.

The goal is to create a **system of work for mixed human and machine actors**.

It should make project execution explicit enough to coordinate, inspect, govern, test, and improve without unnecessarily constraining how intelligent actors perform their work.

---

# 2. The Problem

Agent harnesses are becoming increasingly capable.

They can:

- inspect repositories;
- research;
- design;
- implement;
- test;
- review;
- use tools;
- operate computers;
- coordinate with subagents.

The limiting problem is increasingly not:

> Can an agent perform this task?

It is:

> **How should many pieces of intelligent work compose into a reliable Project?**

As agent capability increases, informal coordination becomes insufficient.

Without an explicit project model:

- work is duplicated;
- agents reconstruct the same context repeatedly;
- concurrent work collides;
- responsibility becomes ambiguous;
- results become authoritative merely because an agent claims completion;
- review and execution blur together;
- retry loops become uncontrolled;
- knowledge about project process hides inside prompts;
- switching harnesses or models requires redesigning the system;
- humans lose visibility into what the system is actually doing.

The project exists to solve the **coordination problem**, not the intelligence problem.

---

# 3. Mission

Build a portable semantic control plane for Project work performed by humans, agents, and deterministic systems.

The system should make explicit:

- what Work exists;
- how Work relates;
- what execution is currently occurring;
- what state persists;
- what Resources execution may affect;
- what may execute concurrently;
- what Evidence has been produced;
- what conditions must hold for Project state to change;
- who has authority to cause those changes.

The system should leave cognition itself largely unconstrained.

---

# 4. Central Principle

\[
\boxed{
\text{Project is durable; execution is replaceable.}
}
\]

An agent Session is an attempt to perform Work.

It is not the Project.

It need not become a permanent personality.

It need not accumulate an indefinitely growing conversation.

It may terminate after producing useful outputs.

Another Session may continue the Project through durable shared state, Handoffs, Workspace state, and Evidence.

Therefore:

\[
\boxed{
\text{continuity belongs to the Project, not the chat}
}
\]

---

# 5. Agents Are Workers, Not Worlds

An agent should not need its own duplicated universe containing:

- another repository clone;
- another copy of project knowledge;
- another independent project status;
- another interpretation of authoritative state;
- another isolated coordination system.

Different Sessions may inhabit the same Project world.

They may share immutable resources and durable outputs while receiving isolated mutable environments where needed.

The system should therefore prefer:

\[
\text{shared locality}
+
\text{explicit isolation}
\]

over:

\[
\text{duplicated agent-local worlds}
\]

The relevant boundary is determined by coordination and state locality, not persona.

---

# 6. Work Before Workers

The Project model should describe Work independently of who performs it.

Research does not inherently belong to a Research Agent.

Implementation does not inherently belong to an Implementer Agent.

Audit does not inherently belong to an Auditor Agent.

Instead:

\[
\boxed{
\text{Work describes what must happen.}
}
\]

\[
\boxed{
\text{Agent Profiles describe ways of performing it.}
}
\]

This separation allows:

- humans to replace agents;
- agents to replace humans;
- different models to perform the same Work;
- one Profile to perform several kinds of Work;
- several Profiles to compete or collaborate on the same Work.

The Project process must not be coupled unnecessarily to today's agent taxonomy.

---

# 7. Work Is a System of Interacting Processes

Project Work is not merely a list of tasks.

Work may form interacting processes.

Some processes are simple Pipelines:

\[
A
\xrightarrow{Handoff}
B
\xrightarrow{Handoff}
C
\]

where continuity is entirely carried forward through explicit Handoffs.

Other processes maintain persistent state and behave as State Machines.

Some stateful processes additionally possess stable identity and message-addressable behaviour and may therefore be understood as Actors.

The system should support this continuum rather than force every Work Process into either:

- a static task list; or
- a permanent agent.

The appropriate abstraction depends on where state and continuity actually live.

---

# 8. Handoffs Make Work Composable

Whenever possible, Work should communicate through explicit Handoffs.

A good Handoff makes it possible for the next worker to proceed without inheriting the private cognition of the previous worker.

Examples include:

- research briefs;
- design documents;
- patches;
- artifacts;
- test results;
- audit findings;
- Workspace references;
- structured requests.

This creates an important property:

\[
\boxed{
\text{collaboration does not require shared thought}
}
\]

Workers share what matters for the Work.

Their private reasoning remains replaceable.

---

# 9. Execution May Be Nondeterministic; Project State Must Be Governed

Agent cognition is probabilistic and exploratory.

That is useful.

Agents should be free to:

- investigate;
- hypothesize;
- branch;
- revise;
- fail;
- retry;
- propose unexpected solutions.

But exploratory execution should not automatically redefine Project truth.

The constitutional separation is:

\[
\boxed{
\text{execution produces candidates}
}
\]

while:

\[
\boxed{
\text{Merge produces authoritative change}
}
\]

A Session may produce:

- Evidence;
- Handoffs;
- artifacts;
- Proposals.

A Proposal becomes authoritative only when the conditions governing its Merge are satisfied.

This is how the system combines nondeterministic intelligence with reliable state transitions.

---

# 10. Evidence Over Assertion

An agent saying:

> Done.

is not sufficient evidence that Work is done.

Project claims should be grounded where practical in observable Evidence:

- tests;
- artifacts;
- measurements;
- diffs;
- research sources;
- reviews;
- external observations.

Not every decision can be mechanically proven.

But the system should consistently prefer:

\[
\boxed{
\text{claim + provenance + evidence}
}
\]

over:

\[
\boxed{
\text{unverifiable assertion}
}
\]

This applies equally to humans and agents.

---

# 11. Gates Express Requirements

A Gate describes what must be true before some transition may Merge.

Examples:

- tests must pass;
- an audit must succeed;
- a human must approve;
- required Evidence must exist;
- an external condition must hold.

Gates should describe requirements, not implementations.

A Gate is not necessarily:

- an agent;
- a service;
- a workflow step;
- a specific program.

It is a condition on an admissible transition.

This distinction lets implementations evolve without changing Project semantics.

---

# 12. Grants Express Authority

The ability to perform an action must not rely only on an instruction saying not to misuse it.

The system distinguishes:

\[
\boxed{
\text{what an actor is told}
}
\]

from:

\[
\boxed{
\text{what an actor is allowed to do}
}
\]

Capabilities describe classes of effects.

Grants authorize actors to exercise those capabilities within a scope.

This enables bounded delegation.

For example, a Session may be allowed to:

- modify its own isolated Workspace;
- run tests;
- create Evidence;

without being allowed to:

- alter integration state;
- deploy production;
- Merge authoritative Project changes.

Human ownership should remain the default where authority has not explicitly been delegated.

---

# 13. Policy Belongs in the System

Important Project rules should not exist only in prompts.

If correctness depends on a rule, the system should be able to represent that rule independently of whether an agent remembers it.

Policy may govern:

- concurrency;
- resource access;
- retries;
- required Gates;
- Grants;
- supervision;
- Merge authority.

Prompts can explain Policy.

They should not be its sole enforcement mechanism.

---

# 14. Concurrency Should Follow Semantics

Agent count is not the concurrency model.

Two agents with the same role may safely execute simultaneously.

Two agents with different roles may conflict.

Concurrency should therefore follow:

- Work dependencies;
- Resource access;
- Workspace isolation;
- available capacity;
- Policy.

The system should maximize safe parallelism without sacrificing authoritative consistency.

A useful principle is:

\[
\boxed{
\text{serialize conflicts, not identities}
}
\]

---

# 15. Share What Is Shareable

A Project should avoid needless reconstruction of expensive common state.

Examples include:

- repository objects;
- dependency caches;
- project artifacts;
- indexes;
- immutable Workspace state;
- accepted Project facts.

Multiple Sessions should be able to reuse common underlying state where this does not create conflicting mutation.

This reduces:

- latency;
- token use;
- repeated downloads;
- redundant indexing;
- duplicated storage;
- inconsistent local views.

Isolation should be introduced where mutation requires it, not indiscriminately around every agent.

---

# 16. Sessions Should Be Disposable

The Project should remain healthy if a Session disappears.

This means valuable continuity must eventually exist outside transient model state.

A terminated Session may leave behind:

- Handoffs;
- Workspace changes;
- Evidence;
- Proposals;
- History.

Another Session should be able to continue from those durable observations where the Work permits it.

This gives the system freedom to:

- switch models;
- switch providers;
- recover from failure;
- restart execution;
- audit independently;
- use specialized agents temporarily.

---

# 17. Memory Is an Optimization, Not a Constitutional Dependency

Persistent semantic memory can substantially improve agent execution.

It may reduce repeated research, preserve preferences, and help agents recover prior decisions.

But project correctness must not depend on the existence of one particular memory implementation.

A Project should remain semantically valid if every new Session begins with no long-term agent memory beyond the Context explicitly assembled for it.

Therefore memory belongs to the cognition infrastructure surrounding Sessions, not the constitutional core of Project coordination.

This preserves replaceability of:

- memory systems;
- retrieval strategies;
- context assembly;
- summarization techniques.

---

# 18. Humans and Agents Share the Same Work Model

The system should avoid creating parallel worlds for:

- human work;
- agent work.

A Work object is Work regardless of its executor.

A Gate is a Gate regardless of whether a human or machine satisfies it.

A Grant represents authority regardless of whether its holder is a person or agent.

Evidence should retain provenance regardless of its producer.

This allows humans and agents to collaborate in the same Project rather than requiring agents to operate inside a separate automation subsystem.

---

# 19. Determinism Where It Is Cheap, Intelligence Where It Is Valuable

Agents should not be used merely because they are available.

If a rule is mechanically checkable, deterministic machinery is usually preferable.

Examples include:

- schema validation;
- dependency satisfaction;
- permissions;
- test outcomes;
- resource conflicts;
- revision compatibility.

Agents are valuable where interpretation, judgment, exploration, or synthesis is needed.

The system should therefore seek:

\[
\boxed{
\text{deterministic constraints around nondeterministic workers}
}
\]

rather than either:

- trying to make agents deterministic; or
- making deterministic problems depend on agent judgment.

---

# 20. Portable Semantics Over Vendor Primitives

The Project ontology must outlive today's infrastructure choices.

Cloudflare Durable Objects may be an excellent realization of persistent Project coordination.

Flue may be an excellent representation of Agent Profiles.

Pi, Claude Code, Codex, or another harness may execute Sessions.

Git worktrees may provide Workspace isolation.

Hindsight may provide semantic memory.

These choices are useful precisely because the Project model does not depend upon them.

The constitutional boundary is:

\[
\boxed{
\text{domain semantics}
\neq
\text{runtime mechanics}
}
\]

Adapters may change.

The meaning of Project, Work, Session, Handoff, Gate, Grant, Evidence, Proposal, and Merge should not.

---

# 21. The System Should Be Observable

A Project should not become an opaque swarm of autonomous agents.

Humans and supervising systems should be able to understand:

- what Work exists;
- what is currently executing;
- what is blocked;
- what depends on what;
- which Resources are occupied;
- what Evidence exists;
- what transitions are proposed;
- what Gates remain unsatisfied;
- which actor has which Grants;
- what has been Merged into authoritative state.

Observability is not merely debugging infrastructure.

It is part of maintaining understandable delegated work.

---

# 22. The System Should Be Testable

The purpose of explicit semantics is partly to make the work system itself measurable.

We should be able to ask:

- Does adding an auditor improve quality?
- Does parallel execution improve throughput?
- Does a particular agent profile reduce failures?
- Does a memory system improve execution enough to justify its cost?
- Does a stricter Gate reduce regressions?
- Does an agent outperform a deterministic procedure for this Stage?
- Does human review improve outcomes enough to remain required?

The system should make these organizational questions experimentally answerable.

Agents are therefore not merely workers.

They are interchangeable components of a measurable process.

---

# 23. The Larger Goal

The project begins with software development because software gives unusually rich:

- artifacts;
- tests;
- versioning;
- structured Work;
- machine-readable Evidence;
- reproducible environments.

But the underlying model is broader.

The long-term subject is:

\[
\boxed{
\text{systems of work}
}
\]

A Project consists of:

- objectives;
- processes;
- actors;
- resources;
- evidence;
- authority;
- rules;
- feedback.

AI agents make it practical to automate or augment parts of these systems that were previously inseparable from human labor.

The opportunity is not merely to reproduce existing project-management software with chatbots.

It is to model the underlying system explicitly enough that humans and machine actors can participate interchangeably where appropriate.

---

# 24. Goals

The project aims to provide a model in which:

1. **Projects persist independently of agents.**

2. **Work is explicit and independent of its executor.**

3. **Work can compose as Pipelines, State Machines, and Actor-like processes.**

4. **Handoffs make execution boundaries explicit.**

5. **Sessions are bounded and disposable.**

6. **Independent Work can safely execute concurrently.**

7. **Shared Project state can be reused without uncontrolled shared mutation.**

8. **Evidence remains associated with its provenance.**

9. **Agent results remain speculative until governed Merge.**

10. **Gates describe requirements for transitions.**

11. **Grants describe bounded authority.**

12. **Policy exists independently of prompts.**

13. **Humans and agents participate in the same Work model.**

14. **Agent harnesses, models, memory systems, and infrastructure remain replaceable.**

15. **The structure and performance of the work system itself can be evaluated.**

---

# 25. Non-Goals

## 25.1 Building a better foundation model

The system consumes intelligence.

It does not attempt to create the underlying model.

---

## 25.2 Building one universal agent harness

Claude Code, Codex, Pi, and future harnesses may have different strengths.

The project should orchestrate or host appropriate execution rather than require all cognition to pass through one proprietary loop.

---

## 25.3 Making agents permanently autonomous

Autonomy is a delegated property, not the objective.

Some Sessions may execute independently.

Others may require frequent human interaction.

The architecture should support both.

---

## 25.4 Eliminating humans

The goal is not a human-free company or software process.

The goal is to make execution roles explicit enough that the appropriate actor—human, agent, or deterministic system—can perform them.

---

## 25.5 Replacing existing specialized infrastructure unnecessarily

The project should not recreate:

- source control;
- databases;
- container runtimes;
- agent harnesses;
- memory engines;
- CI systems;
- cloud schedulers;

unless the existing abstraction fundamentally prevents the desired semantics.

Prefer composition over reinvention.

---

## 25.6 Encoding every organizational concept

The project should not become a universal enterprise ontology.

Concepts should enter the core only when they are necessary to describe coordinated Work.

Peripheral concerns should remain extensions.

---

## 25.7 Treating memory as authoritative state

Semantic memory may be useful, but it is not a replacement for explicit Project facts, Evidence, or authoritative ownership.

---

## 25.8 Treating natural-language instructions as security boundaries

A model promising not to perform an action is not equivalent to lacking authority to perform it.

---

## 25.9 Maximizing agent count

Multi-agent execution is useful only when division of Work provides value.

One well-contextualized Session may be preferable to many poorly coordinated Sessions.

---

## 25.10 Maximizing automation

A deterministic process, human action, or simple Pipeline Step may be superior to an autonomous agent.

The system should choose mechanisms according to the Work.

---

# 26. Design Heuristics

When making architectural decisions, prefer the option that:

### Keeps durable truth outside disposable cognition

Ask:

> Would this still work if the current agent vanished?

---

### Represents Work before assigning workers

Ask:

> Are we modeling what needs doing, or merely what today's agent implementation happens to do?

---

### Externalizes handoffs

Ask:

> What does the next worker actually need?

---

### Shares immutable state

Ask:

> Are we duplicating this only because the agents happen to be separate processes?

---

### Isolates mutation

Ask:

> What state genuinely conflicts if these executions overlap?

---

### Makes authority explicit

Ask:

> Can the actor technically cause this effect, or have we merely told it not to?

---

### Uses evidence for important claims

Ask:

> How could another actor independently inspect why this transition is justified?

---

### Keeps infrastructure replaceable

Ask:

> Is this a domain concept, or just how the current provider happens to implement it?

---

### Uses agents only where cognition helps

Ask:

> Could this requirement be expressed more reliably as a deterministic rule?

---

### Preserves human legibility

Ask:

> Can someone understand what the Project is doing without reconstructing dozens of chat transcripts?

---

# 27. Constitutional Invariants

The following principles should be treated as unusually expensive to violate.

### C1 — Project over Agent

The Project, not an individual agent, is the principal durable coordination domain.

### C2 — Work over Role

Work semantics do not depend on a particular worker identity.

### C3 — Bounded Sessions

Agent execution occurs in bounded Sessions.

### C4 — Durable Handoffs

Collaboration should not require preservation of private transient cognition.

### C5 — Explicit State

Persistent state should have explicit ownership.

### C6 — Safe Concurrency

Concurrency follows dependency and Resource semantics rather than role identity.

### C7 — Evidence Before Authority

Agent output is not authoritative merely because it was produced.

### C8 — Governed Merge

Changes to authoritative Project state occur through explicit Merge semantics.

### C9 — Gates Are Requirements

Transition requirements remain distinct from the actors or mechanisms that evaluate them.

### C10 — Grants Are Authority

Capability possession is explicit and scoped.

### C11 — Policy Outside Prompts

Critical rules exist independently of natural-language agent instructions.

### C12 — Replaceable Cognition

Models, harnesses, and memory systems remain replaceable components.

### C13 — Shared Project World

Sessions should reuse Project-local state where sharing is semantically safe.

### C14 — Mechanism Follows Semantics

Pipeline, State Machine, Actor, human procedure, deterministic automation, and agent execution are mechanisms chosen according to the Work.

### C15 — Observable Delegation

Delegated work remains inspectable by its owners.

---

# 28. Success

The project succeeds when a Project can contain many pieces of Work performed by different humans and machine actors over time, while preserving one understandable and governed project world.

A successful system should make the following ordinary:

> A researcher finishes and disappears.  
> Their Handoff becomes input to design.  
> Two implementations proceed concurrently in isolated environments.  
> An auditor independently examines one implementation.  
> Tests and review satisfy its Gates.  
> An actor with the required Grant Merges the result.  
> The Project continues.  
> None of these steps require one immortal agent or one enormous shared conversation.

At larger scale:

> Work Processes may be replaced, reordered, automated, delegated, measured, and improved without redefining the Project itself.

That is the intended foundation.

---

# 29. North Star

The project is not an operating system because agents need another metaphorical computer.

It is operating-system-like because intelligent work now requires explicit machinery for:

- scheduling;
- isolation;
- durable state;
- communication;
- capabilities;
- authority;
- supervision;
- observation.

The ultimate objective is:

\[
\boxed{
\text{make intelligent work composable}
}
\]

without making it opaque, uncontrolled, or dependent on any particular intelligent worker.

The Project should be able to outlive every agent that works on it.