# Upstream attribution

The unmodified pure board domain in vendor/dsh-board/board.js is copied from
https://github.com/fenglufa/dsh-board at commit ee917e1886766d3ef28f45699a8c1147ee9ab51d.
Original path: dist/board.js. Its MIT license is preserved alongside it.

The local adapter adds conversation association, recovery checkpoints, evidence,
durable writes, and a conversation-first UI. It does not install the upstream
plugin or change its existing storage.

Design references, without bundled code:
- https://github.com/Mason-1011/dsh-task-center
- https://github.com/OthmanAdi/planning-with-files
