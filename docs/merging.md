# How kryfsec merges changes

Two devices can change the same data while apart (one offline, or both between
syncs). When they meet again, kryfsec has to decide what the result is. This page
says what well-known apps do, and what kryfsec does.

## What others do

| App | What happens on a clash | Source |
| --- | --- | --- |
| **Figma** | Last writer wins **per property** of each object. Two people changing different properties of the same object do not clash. Same property: the last value to reach the server wins. Text in one property is never merged ("AB" + "BC" gives one of them, never "ABC"). | [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) |
| **Actual Budget** (James Long) | Every change is a message for one `table/row/column`, stamped with a **hybrid logical clock**. Last write wins per field, compared by the stamp. A Merkle tree finds missing messages. | [Using CRDTs in the wild](https://archive.jlongster.com/using-crdts-in-the-wild), [CRDTs for Mortals slides](https://static.jlongster.com/archive/s/dotjs-crdt-slides.pdf), [timestamp.ts](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/crdt/timestamp.ts) |
| **Linear** | Local object graph with queued changes, rebased on top of server updates. Last writer wins for most fields (the server's order decides). Rich-text issue descriptions later moved to a CRDT. | [Scaling the Linear Sync Engine (talk)](https://www.youtube.com/watch?v=Wo2m3jaJixU), [linear.app/now](https://www.linear.app/now/scaling-the-linear-sync-engine) |
| **Apple CloudKit** | Saves are "locked": if the record changed on the server, the save fails with `serverRecordChanged` and the app gets **three** copies (yours, the original, the server's) to do a three-way merge itself, then retry. | [CKError.serverRecord](https://developer.apple.com/documentation/cloudkit/ckerror/serverrecord), [WWDC14 Advanced CloudKit notes](https://wwdcnotes.com/documentation/wwdc14-231-advanced-cloudkit/) |
| **Obsidian Sync** | Markdown notes are merged with diff-match-patch. Other files: last modified wins. Since 1.9.7 you can choose "Create conflict file" instead, named `note (Conflicted copy device time).md`. Obsidian warns that auto-merge "may sometimes create duplicate text". | [Troubleshoot Obsidian Sync](https://obsidian.md/help/sync/troubleshoot) |

The clock most of them build on is the **hybrid logical clock** (HLC):
Kulkarni et al., [Logical Physical Clocks](https://cse.buffalo.edu/tech-reports/2014-04.pdf) (OPODIS 2014).

## What kryfsec does

It takes the best parts of the above and adds a few things.

1. **Every field has its own stamp** (like Figma and Actual). Changing a note's
   title on the phone and its tags on the laptop keeps both.

2. **Stamps are hybrid logical clocks** (like Actual). A stamp is
   `time-counter-device`, and stamps compare as plain strings. The clock never
   goes backwards, and it moves forward when it sees a newer stamp from another
   device. Two changes at the same moment are ordered by device id, so every
   device picks the same winner. Stamps more than 24 hours in the future are
   ignored, so one device with a wrong clock cannot win forever.

3. **Edits are stamped when you make them, not when you sync.** The apps stamp
   changes right after each save, even offline. If you edit a title on a plane
   at 10:00 and someone else edits it at 11:00 with a connection, the 11:00 edit
   wins when you land, even though your phone syncs later. (Server-ordered
   systems like Figma would pick whichever reached the server last.)

4. **Note text is merged line by line** (better than Figma's "one wins", safer
   than Obsidian's fuzzy patch). For long text fields (journal entries, lab
   write-ups, notes) kryfsec keeps the last synced version as the common base,
   like CloudKit's ancestor record, and does a three-way merge
   ([diff3](https://github.com/bhousel/node-diff3)):
   - you changed line 1, the other device changed line 9: both kept, no prompt;
   - both changed **the same lines** in different ways: the newer version stays
     in the note, and the other version is saved next to it as
     **"<title> (conflict copy)"**. Nothing is lost and no text is doubled.
   diff3 only merges when the base matches exactly, so it never guesses
   where text goes (the "duplicate text" problem of fuzzy patching).

5. **Deletes are remembered** (tombstones). A deleted item is kept as a small
   marker so another device does not bring it back. If one device deletes an item
   and another edits it **after** the delete, the edit wins and the item comes
   back (losing someone's newer work is worse than an extra item). Markers older
   than 60 days are cleaned up, and the cleanup point is synced too, so an old
   offline device cannot bring cleaned-up items back.

6. **The server only does locking** (like CloudKit). It stores one encrypted blob
   and a version number. A save must say which version it is based on
   (`If-Match`). If someone else saved first, the server says 409, the app
   pulls, merges and tries again. The server never sees the data, so all merging
   happens on the devices.

7. **The same answer everywhere.** The merge does not care which side is "local",
   and running it twice gives the same result. Conflict copies get ids made from
   the clash itself, so two devices that hit the same clash make the same copy
   instead of two.

8. **Joining is gentle.** The first time a device joins a vault that has data,
   its own starter roadmap and examples are left out (so they are not added
   twice), shared settings come from the vault, and anything you made yourself
   on that device is added.

9. **Some fields stay on each device.** The theme (dark or light) is not synced,
   so the phone and the laptop can each look the way you like.

## Limits

- One shared document, stored as encrypted pieces (see [chunking.md](chunking.md)),
  not per-change messages. Fine for a personal journal (up to 64 MB encrypted,
  after gzip), not for huge data.
- The order of items in a list is not synced. New items go to the top.
- A text merge works on whole lines. Two edits on the same line always make a
  conflict copy.
- If the sync key is lost, the data on the server cannot be read by anyone,
  including us. Keep the key somewhere safe.

## Where the code is

- `packages/core/src/hlc.ts`: the clock
- `packages/core/src/doc.ts`: stamping, merge, tombstones, cleanup
- `packages/core/src/text.ts`: line-based three-way merge
- `packages/core/src/chunks.ts`: splitting the doc into encrypted pieces
- `packages/core/src/engine.ts`: one sync round (pull, merge, push with `If-Match`, retry)
- `packages/core/src/controller.ts`: when to sync (after edits, on open, retry when offline)
- `packages/core/src/kryfsec.ts`: the kryfsec data schema (which fields are text, which stay local)
- `packages/core/test/merge.test.ts`: the cases above, as tests
