# Project Agent Runtime
## Domain Ontology and Semantic Specification

**Status:** Draft v0.5

---

# 1. Purpose

This specification defines the ontology and semantics of coordinated project work performed by humans, AI agents, and deterministic systems.

It establishes a ubiquitous language for:

1. **Ontology** — what kinds of objects exist.
2. **Relations** — how those objects are associated.
3. **Dynamics** — how work progresses and state changes.
4. **Laws** — which interactions and transitions are admissible.

The specification is implementation-independent.

Systems such as Cloudflare Durable Objects, Flue, Pi, Claude Code, Codex, Git worktrees, Hindsight, workflow engines, and databases may realize parts of this model without becoming concepts of the model itself.

---

# 2. Foundational Concerns

The domain distinguishes four fundamental concerns:

\[
\boxed{
\text{State},\quad
\text{Execution},\quad
\text{Environment},\quad
\text{Law}
}
\]

They answer different questions:

| Concern | Question |
|---|---|
| State | What facts and persistent objects presently exist? |
| Execution | What work is being performed? |
| Environment | What can execution observe or change? |
| Law | Under what conditions may execution and state transitions occur? |

These concerns have independent lifecycles.

In particular:

\[
\boxed{
\text{Project continuity}
\neq
\text{Session continuity}
}
\]

A Session may terminate while Project state, Work, Resources, Evidence, and Workspace state remain.

---

# 3. Ubiquitous Language

The primary objects are:

\[
\boxed{
Project,\,
Work,\,
AgentProfile,\,
Session,\,
Workspace,\,
Resource,\,
Handoff,\,
Evidence,\,
Proposal
}
\]

The principal relations and laws are:

\[
\boxed{
Dependency,\,
Access,\,
Capability,\,
Grant,\,
Gate,\,
Policy,\,
Supervision,\,
Merge
}
\]

The principal derived structures are:

\[
\boxed{
Workgraph,\,
Pipeline,\,
WorkProcess,\,
StateMachine,\,
Actor,\,
WorkspaceView,\,
Context,\,
CanonicalState,\,
History
}
\]

Derived structures have domain meaning without necessarily possessing independent stored identity.

---

# 4. Project

A **Project** is a durable coordination scope for related Work.

Let:

\[
\mathcal P
\]

be the set of Projects.

Project-scoped objects are related by:

\[
\operatorname{projectOf}(x)=P
\]

A Project establishes the semantic world within which:

- Work relates;
- Work Processes interact;
- Sessions execute;
- Resources are coordinated;
- Evidence is produced;
- Proposals are evaluated;
- authoritative state changes.

A Project persists independently of active Sessions:

\[
\operatorname{terminate}(S)
\not\Rightarrow
\operatorname{terminate}(P)
\]

A Project need not correspond to one physical process, database, or runtime object.

---

# 5. Canonical State

**Canonical State** is the logical composition of facts presently accepted as authoritative within a Project.

Let:

\[
F_P
\]

be the authoritative facts relevant to Project \(P\).

For each authoritative fact \(f\):

\[
\operatorname{authorityOf}(f)=a
\]

where \(a\) is the unique semantic authority for that fact at that time.

Then Canonical State is:

\[
C_P
=
\bigcup_{f\in F_P}
\operatorname{authoritativeValue}(f)
\]

Canonical State is therefore:

\[
\boxed{
\text{logically unified but not necessarily physically centralized}
}
\]

Different facts may be owned by different authoritative subsystems.

---

# 6. Work

**Work** is an intended project objective.

Let:

\[
\mathcal W
\]

be the set of Work objects.

Work may represent:

- investigation;
- design;
- implementation;
- evaluation;
- integration;
- maintenance;
- decision;
- coordination;
- any other bounded project objective.

A Ticket is one concrete bounded form of Work.

Work exists independently of who performs it:

\[
\text{Work}\neq\text{Session}
\]

and the same Work may be attempted by multiple Sessions.

---

# 7. Work Kind

Work may be classified by Kind:

\[
\operatorname{kind}:
\mathcal W
\rightarrow
\mathcal K
\]

Examples include:

\[
\mathcal K
=
\{
Research,
Design,
Implementation,
Audit,
Integration,
Maintenance,\ldots
\}
\]

Kind describes the semantic nature of Work.

It does not determine the identity of its executor.

Thus:

\[
\operatorname{kind}(W)=Implementation
\]

does not imply that only one privileged Implementer role may perform \(W\).

---

# 8. Work Process

A **Work Process** is the behavioural realization of Work.

A Work Process:

- receives input;
- performs some transformation or interaction;
- may maintain state;
- produces output;
- may emit Handoffs, Evidence, or Proposals.

Let:

\[
\mathcal N
\]

be the set of Work Processes.

A Work Process may be:

1. transitional and stateless;
2. stateful;
3. actor-like.

These forms differ by where continuity resides.

---

# 9. Handoff

A **Handoff** is information transferred from one Work Process to another.

Let:

\[
H_{ij}
\]

denote a Handoff from \(N_i\) to \(N_j\):

\[
N_i
\xrightarrow{H_{ij}}
N_j
\]

A Handoff may contain or refer to:

- documents;
- artifacts;
- Evidence;
- Workspace state;
- requested outcomes;
- decisions;
- contextual metadata;
- Proposals.

A Handoff moves the execution of Work forward.

Its central semantic role is:

\[
\boxed{
\text{Handoff transfers continuity between Work Processes}
}
\]

---

# 10. Pipeline

A **Pipeline** is a composition of Work Processes whose required continuity is carried through Handoffs.

For a Pipeline:

\[
N_1
\xrightarrow{H_{12}}
N_2
\xrightarrow{H_{23}}
N_3
\rightarrow\cdots
\rightarrow
N_n
\]

each Process may be modeled transitionally:

\[
N_i:
X_i
\rightarrow
X_{i+1}
\]

where the information required by the next Process is represented in the Handoff or otherwise externally observable input.

From the perspective of Project semantics, the Process does not require persistent private state across invocations.

Thus, for a pure Pipeline Step:

\[
Q_i=\varnothing
\]

where \(Q_i\) denotes semantically required private persistent state.

The defining property of a Pipeline is therefore:

\[
\boxed{
\text{required continuity is externalized into Handoffs}
}
\]

A Process may physically cache information without ceasing to be a Pipeline Step, provided that cached state is not semantically required for continuation.

---

# 11. Stateful Work Process

A **Stateful Work Process** preserves private state across interactions.

Let:

\[
Q
\]

be its persistent state and \(M\) an incoming message or Handoff.

Its behaviour is:

\[
\delta:
Q\times M
\rightarrow
Q'\times O
\]

Future behaviour depends not only on the next Handoff but also on persisted state:

\[
\delta(Q,M)
\neq
\delta(Q',M)
\]

in general.

Therefore continuity is no longer carried solely by messages.

---

# 12. State Machine

A **State Machine** is a Stateful Work Process whose possible states and transitions constitute part of its semantics.

Let:

\[
\mathcal Q
\]

be its state space.

Its transition relation is:

\[
\delta:
\mathcal Q\times\mathcal M
\rightarrow
\mathcal Q\times\mathcal O
\]

or, more generally:

\[
q
\xrightarrow{m/o}
q'
\]

A State Machine may still exist without stable addressable identity.

---

# 13. Actor

An **Actor** is a State Machine possessing:

1. stable identity;
2. private persistent state;
3. message-addressable interaction;
4. ownership of its state transitions.

An Actor may therefore be represented abstractly as:

\[
A=(id,Q,\delta)
\]

with:

\[
\delta_A:
Q\times M
\rightarrow
Q'\times O
\]

The defining progression is:

\[
\boxed{
\text{Step}
\xrightarrow{\text{persistent state}}
\text{State Machine}
\xrightarrow{\text{identity + messaging + state ownership}}
\text{Actor}
}
\]

Semantic memory is not required for actorhood.

Memory may be part of \(Q\), but ordinary persistent coordination state is sufficient.

---

# 14. Workgraph

A **Workgraph** is a composition of interacting Work Processes.

Let:

\[
G=(N,E)
\]

where:

- \(N\) is a set of Work Processes;
- \(E\) is a set of admissible interaction or Handoff relations.

An edge:

\[
N_i\xrightarrow{H}N_j
\]

means that output or interaction from \(N_i\) may drive \(N_j\).

A Workgraph may contain:

- pure Pipeline Steps;
- Stateful Work Processes;
- Actors;
- mixtures of all three.

Thus:

\[
\boxed{
\text{Workgraph is the general composition structure}
}
\]

while:

\[
\boxed{
\text{Pipeline is the stateless handoff-carried special case}
}
\]

---

# 15. Dependency

A **Dependency** expresses a constraint on when Work may progress.

Define:

\[
\prec
\subseteq
\mathcal W\times\mathcal W
\]

such that:

\[
W_a\prec W_b
\]

means some required condition associated with \(W_a\) must hold before \(W_b\) becomes admissible.

Dependency and Handoff are distinct.

A Dependency says:

\[
\boxed{
\text{what must precede what}
}
\]

A Handoff says:

\[
\boxed{
\text{what information or control passes between processes}
}
\]

A dependency may exist without a direct Handoff.

A Handoff may transmit information without fully satisfying a dependency.

---

# 16. Agent Profile

An **Agent Profile** is a reusable specification of cognitive execution.

Let:

\[
\mathcal A
\]

be the set of Agent Profiles.

A Profile may determine:

- role;
- instructions;
- skills;
- model policy;
- default capabilities;
- execution conventions.

A Profile is not an active agent.

It may be instantiated repeatedly:

\[
A
\rightsquigarrow
S_1,S_2,\ldots,S_n
\]

A Profile contains no mutable Project execution state by definition.

---

# 17. Session

A **Session** is one bounded execution of an Agent Profile attempting Work.

Let:

\[
\mathcal S
\]

be the set of Sessions.

The attempt relation is:

\[
\operatorname{attempts}
\subseteq
\mathcal S\times\mathcal W
\]

such that:

\[
\operatorname{attempts}(S,W)
\]

means Session \(S\) is one attempt to perform Work \(W\).

There is no separate Attempt object.

A retry creates another Session:

\[
S_1,S_2,\ldots,S_n
\]

with:

\[
\forall i,\quad
\operatorname{attempts}(S_i,W)
\]

---

# 18. Session Envelope

A Session may be characterized as:

\[
S=(A,W,C,H,E)
\]

where:

- \(A\) is its Agent Profile;
- \(W\) is the Work attempted;
- \(C\) is its Context;
- \(H\) is its Session History;
- \(E\) is its Evidence envelope.

The Session is the bounded execution itself.

Its active cognition may disappear at termination.

Its durable outputs may remain.

---

# 19. Session History

**Session History** is the ordered record of observable interaction during a Session.

Let:

\[
H_S
=
\langle h_1,h_2,\ldots,h_n\rangle
\]

History may include:

- messages;
- tool observations;
- decisions;
- commands;
- responses;
- runtime events.

History supports:

- provenance;
- audit;
- replay;
- debugging;
- context reconstruction.

The ontology does not require semantic long-term memory to be derived from History.

---

# 20. Bounded Execution

Every Session has bounded continuation semantics.

There is no primitive rule permitting:

\[
S_1
\rightarrow
S_2
\rightarrow
S_3
\rightarrow\cdots
\]

without a governing continuation condition.

Retries and repeated execution are explicit.

Therefore:

\[
\boxed{
\text{unbounded autonomous continuation is not primitive}
}
\]

---

# 21. Context

**Context** is the bounded information available to a Session.

Let:

\[
C\in\mathcal C_{ctx}
\]

The ontology does not prescribe how Context is constructed.

Context may derive from:

- Project state;
- Work;
- Handoffs;
- Workspace observations;
- Evidence;
- Session History;
- semantic memory;
- retrieval systems;
- external information;
- human input.

Memory and retrieval are therefore external concerns.

The Project runtime requires only that execution receives some finite Context.

---

# 22. Workspace

A **Workspace** is durable environment state upon which project work operates.

Let:

\[
\Omega
\]

denote a Workspace.

A Workspace may expose:

- repositories;
- files;
- generated outputs;
- indexes;
- caches;
- working copies;
- build state;
- other mutable or immutable resources.

Workspace continuity is independent of Session continuity:

\[
\operatorname{terminate}(S)
\not\Rightarrow
\operatorname{destroy}(\Omega)
\]

---

# 23. Workspace View

A **Workspace View** is the environment visible to a Session under some scope and access relation.

For Session \(S\):

\[
V_S
=
\operatorname{view}(\Omega,S)
\]

Multiple Sessions may share immutable underlying state while observing isolated mutable views.

For concurrent Sessions \(S_a\) and \(S_b\):

\[
S_a\parallel S_b
\land
\operatorname{writes}(S_a,r)
\land
\operatorname{writes}(S_b,r)
\]

requires either isolated effective resources:

\[
r\mapsto(r_a,r_b)
\]

with:

\[
r_a\neq r_b
\]

or serialization:

\[
S_a<S_b
\quad\lor\quad
S_b<S_a
\]

---

# 24. Resource

A **Resource** is anything whose use may constrain concurrent execution.

Let:

\[
\mathcal R
\]

be the Resource set.

Examples include:

- files;
- branches;
- Workspace Views;
- integration targets;
- deployment environments;
- external services;
- accounts;
- devices;
- scarce execution capacity.

Resources are defined semantically by the need to coordinate access.

---

# 25. Access

Access is a relation among Sessions, Resources, and access modes.

Let:

\[
\mathcal M
=
\{
Read,
Write,
Exclusive
\}
\]

at minimum.

Define:

\[
\operatorname{access}
\subseteq
\mathcal S\times\mathcal R\times\mathcal M
\]

A compatibility relation:

\[
\bowtie
\subseteq
\mathcal M\times\mathcal M
\]

defines which accesses may coexist.

At minimum:

\[
Read\bowtie Read
\]

while:

\[
\neg(Write\bowtie Write)
\]

for the same non-isolated mutable Resource.

And:

\[
\forall m\in\mathcal M,
\quad
\neg(Exclusive\bowtie m)
\]

for competing access.

---

# 26. Resource Conflict

Two Sessions conflict when they access a common Resource through incompatible modes.

\[
\operatorname{conflict}(S_a,S_b)
\]

iff:

\[
\exists r,m_a,m_b
\]

such that:

\[
\operatorname{access}(S_a,r,m_a)
\]

and:

\[
\operatorname{access}(S_b,r,m_b)
\]

and:

\[
\neg(m_a\bowtie m_b)
\]

A scheduler may admit both only if isolation changes the effective Resource relation.

---

# 27. Concurrency

Two Sessions may execute concurrently:

\[
S_a\parallel S_b
\]

when:

\[
\operatorname{ready}(S_a)
\land
\operatorname{ready}(S_b)
\]

and:

\[
\neg\operatorname{conflict}(S_a,S_b)
\]

and applicable Policy permits both.

Concurrency is independent of role identity.

Thus:

\[
\operatorname{profile}(S_a)
=
\operatorname{profile}(S_b)
\]

does not imply:

\[
\neg(S_a\parallel S_b)
\]

Agent role is not a synchronization primitive.

---

# 28. Scheduling

**Scheduling** determines which eligible Sessions may execute.

Conceptually:

\[
\sigma:
(P,\mathcal S_{pending},R,\Pi)
\rightarrow
D
\]

where:

- \(P\) is observable Project state;
- \(\mathcal S_{pending}\) is pending Session execution;
- \(R\) is Resource state;
- \(\Pi\) is Policy;
- \(D\) is the resulting scheduling decision set.

A Session is runnable only if:

\[
\operatorname{dependenciesSatisfied}(S)
\]

and:

\[
\neg\operatorname{conflictWithActive}(S)
\]

and:

\[
\operatorname{permitted}(S,\Pi)
\]

and:

\[
\operatorname{capacityAvailable}(S)
\]

Scheduling governs admissibility, not cognition.

---

# 29. Project Multiplexing

A Project may coordinate many simultaneous Sessions:

\[
S_1\parallel S_2\parallel\cdots\parallel S_n
\]

when their semantic constraints permit concurrency.

The Project therefore behaves as a durable multiplexing coordination domain over:

- Work;
- Work Processes;
- Workspace;
- Resources;
- Sessions;
- authoritative state.

Agent Profiles are programs of execution within this shared Project world rather than persistent worlds of their own.

---

# 30. Project as Actor

A Project coordinator may itself be actor-like when coordination requires persistent private state.

Let Project coordination state be:

\[
Q_P
\]

and Project messages be:

\[
M_P
\]

Then:

\[
\delta_P:
Q_P\times M_P
\rightarrow
Q'_P\times O_P
\]

Messages may include:

- Work submitted;
- Session started;
- Session completed;
- Evidence produced;
- Handoff produced;
- Resource acquired;
- Resource released;
- Proposal submitted.

If Project coordination has:

- stable identity;
- persistent private state;
- addressable messaging;
- ownership of its state transitions;

then it satisfies the Actor semantics of this specification.

---

# 31. Evidence

**Evidence** is a durable, provenanced observation relevant to Work or a proposed state transition.

Let:

\[
\mathcal E
\]

be the set of Evidence.

A Session has an Evidence envelope:

\[
E_S\subseteq\mathcal E
\]

Evidence may include:

- test results;
- diffs;
- benchmarks;
- artifacts;
- research observations;
- logs;
- audit findings;
- measurements.

Evidence has provenance:

\[
\operatorname{producedBy}(e)=S
\]

where applicable.

Evidence should be immutable or explicitly superseded.

---

# 32. Proposal

A **Proposal** is a candidate transition of authoritative Project state.

Let:

\[
\pi=(R,t,E)
\]

where:

- \(R\) is the Project state or revision observed when the Proposal was formed;
- \(t\) is the candidate transition;
- \(E\subseteq\mathcal E\) is supporting Evidence.

A Session may produce a Proposal:

\[
\operatorname{proposes}(S,\pi)
\]

A Proposal represents:

\[
\boxed{
\text{candidate change}
}
\]

not:

\[
\boxed{
\text{accepted truth}
}
\]

Therefore:

\[
\text{Session belief}
\not\Rightarrow
\text{Canonical State}
\]

---

# 33. Capability

A **Capability** denotes a class of effect that may be authorized.

Let:

\[
\mathcal C
\]

be the Capability universe.

Examples may include:

\[
repository.read
\]

\[
workspace.write
\]

\[
shell.execute
\]

\[
deployment.write
\]

\[
project.merge
\]

Capability means:

\[
\boxed{
\text{what kind of effect can be authorized}
}
\]

It does not state who possesses authorization.

---

# 34. Grant

A **Grant** confers a Capability upon an actor within some Scope.

Conceptually:

\[
g=(x,c,s)
\]

where:

- \(x\) is an actor;
- \(c\in\mathcal C\) is a Capability;
- \(s\) is the Scope in which \(c\) may be exercised.

Define:

\[
\operatorname{granted}(x,c,s)
\]

A Grant means:

\[
\boxed{
x
\text{ may exercise }
c
\text{ within }
s
}
\]

Instructions and Grants are distinct:

\[
\boxed{
\text{instruction}\neq\text{grant}
}
\]

Natural-language compliance is not an authority mechanism.

---

# 35. Gate

A **Gate** is a requirement that must hold for a state transition.

A Gate is a predicate.

For transition \(t\):

\[
g_t(P,t,E)
\in
\{\top,\bot\}
\]

Examples include:

\[
g_{tests}
\]

\[
g_{audit}
\]

\[
g_{approval}
\]

A transition cannot Merge while any required Gate remains unsatisfied.

Thus:

\[
\boxed{
\text{Gate = transition requirement}
}
\]

---

# 36. Policy

A **Policy** is a durable law governing admissible execution or transition.

Policy may determine:

- required Gates;
- required Grants;
- Grant eligibility;
- retry bounds;
- resource constraints;
- concurrency;
- scheduling;
- supervision;
- Merge conditions.

Let:

\[
\Pi
\]

denote applicable Policy.

For transition \(t\):

\[
\operatorname{gates}(\Pi,t)
\]

denotes required Gates, while:

\[
\operatorname{requiredGrants}(\Pi,t)
\]

denotes required Grants.

Policy is independent of cognition.

---

# 37. Transition Admissibility

Let:

- \(P\) be current Project state;
- \(t\) be a proposed transition;
- \(x\) be the actor causing it;
- \(E\) be supporting Evidence;
- \(\Pi\) be applicable Policy.

The transition is admissible iff:

\[
\operatorname{dependenciesSatisfied}(t,P)
\]

and:

\[
\bigwedge_{g\in\operatorname{gates}(\Pi,t)}
g(P,t,E)
\]

and:

\[
\operatorname{requiredGrants}(\Pi,t)
\subseteq
\operatorname{grants}(x)
\]

and all additional Policy predicates hold.

This distinguishes:

\[
\boxed{
\text{what must be true}
}
\]

from:

\[
\boxed{
\text{who may cause the transition}
}
\]

Gates express the former.

Grants express the latter.

---

# 38. Merge

A **Merge** reconciles an admissible Proposal into authoritative Project state.

Let:

\[
\mu:
P\times\pi
\rightarrow
P'
\]

be the Merge relation.

For Proposal:

\[
\pi=(R,t,E)
\]

Merge is admissible only if:

\[
\operatorname{compatible}(P,\pi)
\]

and:

\[
\bigwedge_{g\in\operatorname{gates}(\Pi,t)}
g(P,t,E)
\]

and:

\[
\operatorname{requiredGrants}(\Pi,t)
\subseteq
\operatorname{grants}(x)
\]

When these conditions hold:

\[
P_R
\xrightarrow[\mu]{\pi}
P_{R'}
\]

A Merge may represent:

- accepting a design;
- integrating source changes;
- accepting research;
- updating Work state;
- adopting an audit result;
- changing a plan;
- recording an external outcome.

Merge is semantic and broader than any particular source-control operation.

---

# 39. Handoff and Merge

Handoff and Merge are distinct forms of composition.

A **Handoff** composes execution:

\[
N_i
\xrightarrow{H}
N_j
\]

A **Merge** composes candidate change into authoritative state:

\[
P+\pi
\xrightarrow{\mu}
P'
\]

Therefore:

\[
\boxed{
\text{Handoff moves work forward}
}
\]

while:

\[
\boxed{
\text{Merge moves authoritative state forward}
}
\]

A Handoff need not change Canonical State.

A Merge need not transfer execution responsibility to another Work Process.

---

# 40. Revision Safety

A Proposal is formed relative to observed state.

Let:

\[
\pi=(R,t,E)
\]

If current Project state has become \(R'\), then Merge is valid only if the Proposal remains semantically compatible.

Thus:

\[
R\neq R'
\land
\neg\operatorname{compatible}(\pi,R')
\]

implies:

\[
\neg\operatorname{merge}(\pi,R')
\]

A stale Proposal cannot silently alter incompatible authoritative state.

---

# 41. Audit

**Audit** is Work whose objective is independent evaluation of other Work or Evidence.

Formally:

\[
\operatorname{kind}(W_a)=Audit
\]

An auditing Session is an ordinary Session:

\[
\operatorname{attempts}(S_a,W_a)
\]

It may inspect:

- durable Workspace outputs;
- Evidence;
- Handoffs;
- relevant authoritative state;
- observable artifacts.

It need not inherit the transient cognition of the Session whose Work it evaluates.

Thus Audit preserves:

\[
\boxed{
\text{shared observable state}
+
\text{independent cognition}
}
\]

---

# 42. Supervision

**Supervision** is a relation governing continuation of Session execution.

It is not a special actor class.

Let:

\[
\operatorname{supervises}(x,S)
\]

mean actor \(x\) supervises Session \(S\).

Supervision may evaluate:

\[
\nu:
(S,E,\Pi)
\rightarrow
\{
Continue,
Retry,
Cancel,
Escalate
\}
\]

The supervising actor may be:

- a human;
- another Session;
- a deterministic controller.

Supervision asks:

\[
\boxed{
\text{what happens to execution next?}
}
\]

Gate and Merge semantics instead ask:

\[
\boxed{
\text{may this candidate state transition become authoritative?}
}
\]

---

# 43. History

**History** is the derived ordered record of observable domain events.

Let:

\[
H_P
=
\langle e_1,e_2,\ldots,e_n\rangle
\]

History may include:

- Work creation;
- Session lifecycle events;
- Handoffs;
- Resource changes;
- Evidence production;
- Proposal submission;
- Gate satisfaction;
- Merge;
- supervision decisions.

The ontology requires semantic observability of transitions.

It does not require event sourcing.

---

# 44. Memory Is External to the Core

Long-term semantic Memory is intentionally excluded from the core ontology.

A memory system may implement:

\[
H_P
\rightarrow
M_P
\]

and:

\[
(M_P,q,b)
\rightarrow
C
\]

where:

- \(M_P\) is semantic memory;
- \(q\) is a query;
- \(b\) is a finite context budget;
- \(C\) is Session Context.

Memory may improve execution quality but is not necessary for correctness of Work coordination.

A system with no semantic memory can satisfy this specification.

Therefore:

\[
\boxed{
\text{Memory affects cognition, not core Project semantics}
}
\]

---

# 45. State Ownership

Every authoritative mutable fact has exactly one semantic authority at a given time.

For authoritative fact \(f\):

\[
|\operatorname{authorityOf}(f)|=1
\]

This does not prohibit:

- replicas;
- caches;
- projections;
- observations.

It prohibits independently mutable authorities for the same fact.

Thus:

\[
\boxed{
\text{one authoritative fact}
\rightarrow
\text{one authority}
}
\]

Canonical Project state is the logical composition of these authoritative facts.

---

# 46. Project Behaviour

A Project may be viewed coalgebraically as a persistent system observed through transitions.

Let:

\[
P
\]

be Project state.

An observable transition has the form:

\[
P
\xrightarrow{i/o}
P'
\]

where:

- \(i\) is an admissible interaction;
- \(o\) is an observable consequence.

Possible interactions include:

- Work submission;
- Handoff reception;
- Session lifecycle changes;
- Resource access;
- Evidence production;
- Proposal submission;
- Merge.

The possible transitions are constrained by:

- Dependency;
- Resource compatibility;
- Gates;
- Grants;
- Policy.

The physical runtime topology is not part of this behavioural contract.

---

# 47. Session Execution

Cognitive execution may be abstracted as:

\[
\operatorname{execute}:
(A,W,C,V,K)
\rightarrow
(H,E,O)
\]

where:

- \(A\) is an Agent Profile;
- \(W\) is Work;
- \(C\) is Context;
- \(V\) is a Workspace View;
- \(K\) is the Grants available to the Session;
- \(H\) is Session History;
- \(E\) is its Evidence envelope;
- \(O\) may contain Handoffs, Proposals, or other outputs.

The implementation may use human or machine execution.

---

# 48. Pipeline Composition

For a Pipeline:

\[
N_1
\xrightarrow{H_{12}}
N_2
\xrightarrow{H_{23}}
\cdots
\xrightarrow{H_{n-1,n}}
N_n
\]

and each Process behaves as:

\[
N_i(H_{i-1,i})
\rightarrow
H_{i,i+1}
\]

without requiring semantically persistent private state.

Pipeline composition therefore resembles function composition:

\[
N_n
\circ
N_{n-1}
\circ
\cdots
\circ
N_1
\]

subject to the richer structure carried by Handoffs and effects.

---

# 49. Stateful Workgraph Composition

For a stateful node \(N_i\):

\[
N_i(Q_i,H_{ji})
\rightarrow
(Q'_i,H_{ik})
\]

The behaviour of \(N_i\) depends on both:

\[
H_{ji}
\]

and:

\[
Q_i
\]

Therefore the Workgraph cannot be reduced to Handoff composition alone.

The graph contains persistent behavioural loci.

---

# 50. Sequential Collaboration

Let Session \(S_1\) act on Workspace \(\Omega\):

\[
S_1:
\Omega
\rightarrow
\Omega'
\]

After:

\[
\operatorname{terminate}(S_1)
\]

the resulting Workspace state may persist:

\[
\Omega'
\]

A later Session \(S_2\) may observe it:

\[
S_2:
\operatorname{observe}(\Omega')
\]

without requiring:

\[
H_{S_1}
\subseteq
C_{S_2}
\]

Collaboration therefore occurs through durable observable project state and Handoffs rather than required conversational continuity.

---

# 51. Parallel Collaboration

For Sessions \(S_a\) and \(S_b\):

\[
S_a\parallel S_b
\]

is admissible iff:

\[
\operatorname{ready}(S_a)
\land
\operatorname{ready}(S_b)
\]

and:

\[
\neg\operatorname{conflict}(S_a,S_b)
\]

and:

\[
\operatorname{permitted}(S_a,\Pi)
\land
\operatorname{permitted}(S_b,\Pi)
\]

and sufficient capacity exists.

This remains independent of Profile identity.

---

# 52. Speculation

Session outputs are speculative with respect to authoritative Project state.

Let:

\[
x
\]

be an outcome produced during Session \(S\).

Then:

\[
x\notin C_P
\]

merely because \(S\) produced it.

Instead, an authoritative change follows:

\[
S
\rightarrow
E
\rightarrow
\pi
\rightarrow
\text{Gate satisfaction}
\rightarrow
\text{Grant satisfaction}
\rightarrow
\mu
\rightarrow
P'
\]

Only Merge changes authoritative Project state.

---

# 53. Core Relations

The ontology may be summarized through the following principal relations.

### Project scope

\[
\operatorname{projectOf}(x)=P
\]

### Work dependency

\[
W_a\prec W_b
\]

### Work Process interaction

\[
N_i\xrightarrow{H}N_j
\]

### Profile realization

\[
\operatorname{profile}(S)=A
\]

### Work attempt

\[
\operatorname{attempts}(S,W)
\]

### Resource access

\[
\operatorname{access}(S,r,m)
\]

### Evidence production

\[
\operatorname{producedBy}(e)=S
\]

### Proposal production

\[
\operatorname{proposes}(S,\pi)
\]

### Capability grant

\[
\operatorname{granted}(x,c,s)
\]

### Supervision

\[
\operatorname{supervises}(x,S)
\]

### Authoritative ownership

\[
\operatorname{authorityOf}(f)=a
\]

### Merge

\[
P_R
\xrightarrow[\mu]{\pi}
P_{R'}
\]

subject to applicable Laws.

---

# 54. Fundamental Laws

## L1 — Project persistence

\[
\operatorname{terminate}(S)
\not\Rightarrow
\operatorname{terminate}(P)
\]

## L2 — Work–Session distinction

\[
W\neq S
\]

One Work object may be attempted by many Sessions.

## L3 — Session boundedness

Every Session has bounded continuation semantics.

## L4 — Workspace persistence

\[
\operatorname{terminate}(S)
\not\Rightarrow
\operatorname{destroy}(\Omega)
\]

## L5 — Pipeline externalization

For a pure Pipeline Step, all semantically required continuation state is representable in its externally observable input and output.

## L6 — Stateful distinction

A Stateful Work Process has semantically required private state not reducible to the current Handoff alone.

## L7 — Actor identity

An Actor is a stateful process with stable identity, private state ownership, and message-addressable behaviour.

## L8 — Resource safety

\[
S_a\parallel S_b
\Rightarrow
\neg\operatorname{conflict}(S_a,S_b)
\]

unless isolation changes the effective Resource relation.

## L9 — Concurrent mutation isolation

Concurrent writes require disjoint, versioned, or otherwise isolated mutable state.

## L10 — Role-independent concurrency

\[
\operatorname{profile}(S_a)
=
\operatorname{profile}(S_b)
\]

does not imply:

\[
\neg(S_a\parallel S_b)
\]

## L11 — Evidence provenance

Evidence used to justify a Merge has identifiable provenance.

## L12 — No self-Merge

\[
\text{SessionOutput}
\not\Rightarrow
\text{CanonicalState}
\]

## L13 — Gate satisfaction

Every Gate required for a Merge evaluates to true.

## L14 — Grant sufficiency

The actor causing a Merge possesses all Grants required by Policy.

## L15 — Instruction–authority separation

\[
\text{instruction}\neq\text{grant}
\]

## L16 — Revision safety

A Proposal cannot silently Merge against semantically incompatible state.

## L17 — Single authority

Every authoritative mutable fact has one semantic authority at a time.

## L18 — Memory independence

Semantic Memory is not required for correctness of Project coordination.

## L19 — Infrastructure independence

\[
\text{domain identity}
\neq
\text{runtime/vendor identity}
\]

---

# 55. Minimal Semantic Kernel

The minimal ontology consists of:

\[
\boxed{
P,\,
W,\,
N,\,
A,\,
S,\,
\Omega,\,
R,\,
H,\,
E,\,
\pi
}
\]

where:

- \(P\) = Project;
- \(W\) = Work;
- \(N\) = Work Process;
- \(A\) = Agent Profile;
- \(S\) = Session;
- \(\Omega\) = Workspace;
- \(R\) = Resource;
- \(H\) = Handoff;
- \(E\) = Evidence;
- \(\pi\) = Proposal.

Work may be constrained by Dependency:

\[
W_i\prec W_j
\]

Work Processes exchange Handoffs:

\[
N_i\xrightarrow{H}N_j
\]

Agent Profiles instantiate Sessions:

\[
A\rightsquigarrow S
\]

Sessions attempt Work:

\[
\operatorname{attempts}(S,W)
\]

Sessions access Resources:

\[
\operatorname{access}(S,R,m)
\]

Sessions produce Evidence:

\[
S\rightarrow E
\]

Sessions may produce Proposals:

\[
S\rightarrow\pi
\]

and authoritative state changes only through governed Merge:

\[
P_R
\xrightarrow[\Pi,G,K,\mu]{\pi}
P_{R'}
\]

where:

- \(\Pi\) = Policy;
- \(G\) = satisfied Gates;
- \(K\) = sufficient Grants;
- \(\mu\) = Merge.

---

# 56. Semantic Summary

The domain is not fundamentally a collection of persistent AI agents.

It is a system of:

\[
\boxed{
\text{durable Projects}
}
\]

containing:

\[
\boxed{
\text{Work and interacting Work Processes}
}
\]

where Work Processes range from:

\[
\boxed{
\text{stateless Pipeline Steps}
\rightarrow
\text{State Machines}
\rightarrow
\text{Actors}
}
\]

depending on where continuity resides.

Pipeline continuity is carried through:

\[
\boxed{
\text{Handoffs}
}
\]

while stateful processes preserve additional private state.

Agent Profiles instantiate:

\[
\boxed{
\text{bounded Sessions}
}
\]

which act over:

\[
\boxed{
\text{Workspace and Resources}
}
\]

and produce:

\[
\boxed{
\text{Handoffs, Evidence, and candidate Proposals}
}
\]

Authoritative Project state changes only through:

\[
\boxed{
\text{Merge}
}
\]

governed by:

\[
\boxed{
\text{Dependencies}
+
\text{Gates}
+
\text{Grants}
+
\text{Policy}
}
\]

Thus:

\[
\boxed{
\text{Handoff moves Work forward}
}
\]

while:

\[
\boxed{
\text{Merge moves authoritative State forward}
}
\]

Sessions are disposable.

Project state and environment persist independently.

Concurrency follows dependency and resource semantics rather than agent role.

Memory may improve cognition but remains orthogonal to the coordination kernel.

This constitutes the domain's semantic core.