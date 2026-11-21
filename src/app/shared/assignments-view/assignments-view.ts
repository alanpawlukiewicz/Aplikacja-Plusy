import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { SetView } from '../../core/class-structure';
import { AssignmentRow } from '../../core/services/assignment.service';

interface ItemView {
  id: string;
  /** "2.3": task number and subtask number. */
  label: string;
  ownerName: string | null;
  mine: boolean;
  backupName: string | null;
  /** The current user is the stand-in for this subtask. */
  mineBackup: boolean;
}

interface TaskItems {
  taskNo: number;
  items: ItemView[];
}

interface SetItems {
  id: string;
  name: string;
  tasks: TaskItems[];
}

/** Read-only overview of who presents which subtask. Used by the student page and the admin editor. */
@Component({
  selector: 'app-assignments-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './assignments-view.html',
})
export class AssignmentsView {
  readonly sets = input.required<SetView[]>();
  readonly assignments = input.required<AssignmentRow[]>();
  /** Display names keyed by user id. */
  readonly names = input.required<ReadonlyMap<string, string>>();
  readonly currentUserId = input<string | null>(null);

  protected readonly view = computed<SetItems[]>(() => {
    const rows = new Map(this.assignments().map((row) => [row.subtaskId, row]));
    const names = this.names();
    const me = this.currentUserId();

    return this.sets().map((set) => ({
      id: set.id,
      name: set.name,
      tasks: set.tasks.map((task) => ({
        taskNo: task.taskNo,
        items: task.subtasks.map((subtask) => {
          // A subtask without a row (e.g. added after the assignment) counts as free.
          const row = rows.get(subtask.id);
          const ownerId = row?.userId ?? null;
          const backupId = row?.backupUserId ?? null;
          return {
            id: subtask.id,
            label: `${task.taskNo}.${subtask.subtaskNo}`,
            ownerName: ownerId ? (names.get(ownerId) ?? 'Inna osoba') : null,
            mine: ownerId !== null && ownerId === me,
            backupName: backupId ? (names.get(backupId) ?? 'Inna osoba') : null,
            mineBackup: backupId !== null && backupId === me,
          };
        }),
      })),
    }));
  });
}
