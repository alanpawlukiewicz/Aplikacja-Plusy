import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  WritableSignal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CLASS_STATUS_CHIP, CLASS_STATUS_LABELS } from '../../core/class-status';
import { buildSets, SetView, TaskView } from '../../core/class-structure';
import { formatDateTime, formatDay } from '../../core/date-utils';
import { plural } from '../../core/plural';
import { AssignmentRow, AssignmentService } from '../../core/services/assignment.service';
import { ClassRow, ClassService } from '../../core/services/class.service';
import { DeclarationService } from '../../core/services/declaration.service';
import { GroupService } from '../../core/services/group.service';
import { SessionService } from '../../core/services/session.service';
import { AssignmentsView } from '../../shared/assignments-view/assignments-view';
import { ClassPoints } from './class-points';
import { MyAssignmentItem, MyAssignments } from './my-assignments';

const NOT_FOUND_CODE = 'PGRST116'; // `.single()` matched no row (missing id or hidden by RLS)

/** Messages for a class whose open round cannot be changed (deadline passed) or that is past its rounds. */
const CLOSED_MESSAGES: Record<ClassRow['status'], string> = {
  draft: '',
  round1_open: 'Termin zapisów minął. Poniżej widać podpunkty, które zgłosiłeś.',
  round2_open: 'Termin zapisów w turze 2 minął. Poniżej widać wolne podpunkty i przydział z tury 1.',
  assigned: 'Zapisy są zamknięte. Poniżej widać przydział podpunktów.',
  finished: 'Te zajęcia już się zakończyły. Poniżej widać przydział podpunktów.',
};

/**
 * A class as the student sees it.
 *
 * Round 1: all subtasks of the class's task sets; the student marks the ones they want.
 * Round 2: only subtasks nobody got in round 1; the student can add more. Declarations made in
 * round 1 stay (they still count) but are locked, because the database only lets a declaration
 * be withdrawn while its own round is open.
 * Afterwards: who got which subtask.
 *
 * Each click is saved immediately; the UI updates first and rolls back if the save fails.
 */
@Component({
  selector: 'app-class-detail',
  imports: [
    RouterLink,
    MatButtonModule,
    MatProgressSpinnerModule,
    AssignmentsView,
    ClassPoints,
    MyAssignments,
  ],
  templateUrl: './class-detail.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassDetail {
  private readonly session = inject(SessionService);
  private readonly classes = inject(ClassService);
  private readonly declarations = inject(DeclarationService);
  private readonly assignments = inject(AssignmentService);
  private readonly groups = inject(GroupService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly classId = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';

  protected readonly statusLabels = CLASS_STATUS_LABELS;
  protected readonly statusChip = CLASS_STATUS_CHIP;
  protected readonly closedMessages = CLOSED_MESSAGES;
  protected readonly formatDay = formatDay;
  protected readonly formatDateTime = formatDateTime;
  protected readonly plural = plural;

  protected readonly chipBase =
    'rounded-full border px-3.5 py-1.5 text-sm font-medium tabular-nums transition-colors ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-slate-900 disabled:cursor-default disabled:opacity-60';
  protected readonly chipSelected = 'border-slate-900 bg-slate-900 text-white';
  protected readonly chipIdle = 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50';

  protected readonly loading = signal(true);
  protected readonly loadError = signal<'not-found' | 'failed' | null>(null);

  protected readonly row = signal<ClassRow | null>(null);
  protected readonly sets = signal<SetView[]>([]);
  /** True while a round is open and its deadline has not passed. */
  protected readonly editable = signal(false);

  protected readonly assignmentRows = signal<AssignmentRow[]>([]);
  protected readonly names = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly currentUserId = computed(() => this.session.user()?.id ?? null);

  private readonly selected = signal<ReadonlySet<string>>(new Set());
  /** Declared in an earlier round: still counts, but cannot be changed any more. */
  private readonly lockedIds = signal<ReadonlySet<string>>(new Set());
  /** Subtasks with a save in flight; they cannot be clicked again until it finishes. */
  private readonly pending = signal<ReadonlySet<string>>(new Set());

  /** 1 or 2 while that round is open (also after its deadline), otherwise null. */
  protected readonly currentRound = computed<1 | 2 | null>(() => {
    const status = this.row()?.status;
    return status === 'round1_open' ? 1 : status === 'round2_open' ? 2 : null;
  });

  /** Subtasks nobody got in round 1 (also those without an assignment row, like the database). */
  private readonly freeSets = computed<SetView[]>(() => {
    const taken = new Set(
      this.assignmentRows().filter((row) => row.userId !== null).map((row) => row.subtaskId),
    );

    return this.sets()
      .map((set) => ({
        ...set,
        tasks: set.tasks
          .map((task) => ({ ...task, subtasks: task.subtasks.filter((s) => !taken.has(s.id)) }))
          .filter((task) => task.subtasks.length > 0),
      }))
      .filter((set) => set.tasks.length > 0);
  });

  /** What the student can mark: everything in round 1, only the free subtasks in round 2. */
  protected readonly declareSets = computed<SetView[]>(() => {
    const round = this.currentRound();
    return round === 1 ? this.sets() : round === 2 ? this.freeSets() : [];
  });

  /** Number of declared subtasks among the ones shown for declaring. */
  protected readonly selectedCount = computed(() => {
    const selected = this.selected();
    let count = 0;
    for (const set of this.declareSets()) {
      for (const task of set.tasks) {
        count += task.subtasks.filter((subtask) => selected.has(subtask.id)).length;
      }
    }
    return count;
  });

  /** True when some of the shown subtasks were declared in an earlier round. */
  protected readonly hasLocked = computed(() => {
    const locked = this.lockedIds();
    return this.declareSets().some((set) =>
      set.tasks.some((task) => task.subtasks.some((subtask) => locked.has(subtask.id))),
    );
  });

  /** The subtasks assigned to the current user, in order. */
  protected readonly myAssignedItems = computed<MyAssignmentItem[]>(() => {
    const me = this.currentUserId();
    if (!me) {
      return [];
    }

    const mine = new Set(
      this.assignmentRows().filter((row) => row.userId === me).map((row) => row.subtaskId),
    );
    const items: MyAssignmentItem[] = [];
    for (const set of this.sets()) {
      for (const task of set.tasks) {
        for (const subtask of task.subtasks) {
          if (mine.has(subtask.id)) {
            items.push({ id: subtask.id, label: `${task.taskNo}.${subtask.subtaskNo}` });
          }
        }
      }
    }
    return items;
  });

  /** Labels ("2.1") of the subtasks assigned to the current user. */
  protected readonly myAssigned = computed(() => this.myAssignedItems().map((item) => item.label));

  /** Labels of the subtasks the current user stands in for (backup), in order. */
  protected readonly myBackups = computed(() => {
    const me = this.currentUserId();
    if (!me) {
      return [];
    }

    const backed = new Set(
      this.assignmentRows().filter((row) => row.backupUserId === me).map((row) => row.subtaskId),
    );
    const labels: string[] = [];
    for (const set of this.sets()) {
      for (const task of set.tasks) {
        for (const subtask of task.subtasks) {
          if (backed.has(subtask.id)) {
            labels.push(`${task.taskNo}.${subtask.subtaskNo}`);
          }
        }
      }
    }
    return labels;
  });

  /** Giving up an assignment is possible while round 2 is open (others can still take it). */
  protected readonly canRelease = computed(
    () =>
      this.row()?.status === 'round2_open' && this.editable() && this.myAssignedItems().length > 0,
  );

  constructor() {
    void this.load();
  }

  // ----- Loading -----

  /** Loads the page. `quiet` reloads in place (no spinner) and only shows a message on failure. */
  protected async load(quiet = false): Promise<void> {
    const user = this.session.user();
    if (!user) {
      this.loading.set(false);
      return;
    }

    if (!quiet) {
      this.loading.set(true);
      this.loadError.set(null);
    }

    try {
      const detail = await this.classes.getWithTasks(this.classId);

      // Drafts are only for admins; to students they do not exist yet.
      if (detail.row.status === 'draft' && !this.session.isAdmin()) {
        this.loadError.set('not-found');
        return;
      }

      // Assignments exist once round 1 has been assigned.
      const hasAssignments = this.showsAssignments(detail.row.status);
      const [declared, assignmentRows, names] = await Promise.all([
        this.declarations.mine(this.classId, user.id),
        hasAssignments ? this.assignments.forClass(this.classId) : Promise.resolve<AssignmentRow[]>([]),
        hasAssignments ? this.groups.members(detail.row.group_id) : Promise.resolve(new Map<string, string>()),
      ]);

      this.row.set(detail.row);
      this.sets.set(buildSets(detail.taskSets));
      this.selected.set(new Set(declared.map((entry) => entry.subtaskId)));
      this.lockedIds.set(
        new Set(
          detail.row.status === 'round2_open'
            ? declared.filter((entry) => entry.round === 1).map((entry) => entry.subtaskId)
            : [],
        ),
      );
      this.assignmentRows.set(assignmentRows);
      this.names.set(names);
      this.editable.set(this.isDeclaringOpen(detail.row));
    } catch (error) {
      if (quiet) {
        this.snackBar.open('Nie udało się odświeżyć strony. Odśwież ją ręcznie.', 'OK', { duration: 6000 });
      } else {
        const code = (error as { code?: string }).code;
        this.loadError.set(code === NOT_FOUND_CODE ? 'not-found' : 'failed');
      }
    } finally {
      if (!quiet) {
        this.loading.set(false);
      }
    }
  }

  /** Reloads the class after something changed on the server (e.g. a released assignment). */
  protected refresh(): Promise<void> {
    return this.load(true);
  }

  private showsAssignments(status: ClassRow['status']): boolean {
    return status === 'round2_open' || status === 'assigned' || status === 'finished';
  }

  /** A round is open and its deadline (if any) has not passed. */
  private isDeclaringOpen(row: ClassRow): boolean {
    if (row.status !== 'round1_open' && row.status !== 'round2_open') {
      return false;
    }
    return !row.declarations_deadline || Date.now() < new Date(row.declarations_deadline).getTime();
  }

  // ----- Template helpers -----

  protected isSelected(subtaskId: string): boolean {
    return this.selected().has(subtaskId);
  }

  protected isLocked(subtaskId: string): boolean {
    return this.lockedIds().has(subtaskId);
  }

  protected isPending(subtaskId: string): boolean {
    return this.pending().has(subtaskId);
  }

  /** Subtasks of the task that can still be changed. */
  private toggleableIds(task: TaskView): string[] {
    const locked = this.lockedIds();
    return task.subtasks.filter((subtask) => !locked.has(subtask.id)).map((subtask) => subtask.id);
  }

  protected canToggleTask(task: TaskView): boolean {
    return this.toggleableIds(task).length > 0;
  }

  protected allSelected(task: TaskView): boolean {
    const selected = this.selected();
    const ids = this.toggleableIds(task);
    return ids.length > 0 && ids.every((id) => selected.has(id));
  }

  // ----- Declaring -----

  protected toggleSubtask(subtaskId: string): Promise<void> {
    return this.apply([subtaskId], !this.selected().has(subtaskId));
  }

  /** Selects every changeable subtask of the task, or clears them all if they are already all selected. */
  protected toggleTask(task: TaskView): Promise<void> {
    return this.apply(this.toggleableIds(task), !this.allSelected(task));
  }

  private async apply(ids: string[], select: boolean): Promise<void> {
    const user = this.session.user();
    const row = this.row();
    const round = this.currentRound();
    if (!user || !row || !round || !this.editable()) {
      return;
    }

    // The deadline may have passed while the page was open.
    if (!this.isDeclaringOpen(row)) {
      this.editable.set(false);
      this.snackBar.open('Zapisy zostały zamknięte.', 'OK', { duration: 5000 });
      return;
    }

    const pending = this.pending();
    if (ids.some((id) => pending.has(id))) {
      return;
    }

    // Only subtasks whose state really changes; ones from an earlier round are locked.
    const locked = this.lockedIds();
    const changing = ids.filter((id) => !locked.has(id) && this.selected().has(id) !== select);
    if (changing.length === 0) {
      return;
    }

    this.mark(this.pending, changing, true);
    this.mark(this.selected, changing, select); // optimistic update

    try {
      if (select) {
        await this.declarations.add(this.classId, user.id, changing, round);
      } else {
        await this.declarations.remove(this.classId, user.id, changing);
      }
    } catch {
      this.mark(this.selected, changing, !select); // roll back
      this.snackBar.open(
        select
          ? 'Nie udało się zapisać zgłoszenia. Zapisy mogły się już zamknąć.'
          : 'Nie udało się wycofać zgłoszenia. Zapisy mogły się już zamknąć.',
        'OK',
        { duration: 5000 },
      );
    } finally {
      this.mark(this.pending, changing, false);
    }
  }

  /** Adds ids to (or removes them from) a set held in a signal. */
  private mark(target: WritableSignal<ReadonlySet<string>>, ids: string[], add: boolean): void {
    target.update((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (add) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
  }
}