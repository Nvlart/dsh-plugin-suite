window.__ModuleLoader__.load({
	id: 'dsh-thinking-summary',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');

		const CSS = [
			'/* 原生 Deep diving 右侧的计划后缀 */',
			'.thk-plan-suffix {',
			'  font: var(--dsw-font-xs-13);',
			'  font-variant-numeric: tabular-nums;',
			'  color: var(--dsw-alias-label-caption);',
			'  margin-left: 8px;',
			'  font-weight: 400;',
			'  white-space: nowrap;',
			'}',
			'/* 消息流内、每步思考下方的摘要卡片 */',
			'.thk-flow-card {',
			'  display: flex;',
			'  flex-direction: column;',
			'  gap: 4px;',
			'  padding: 8px 12px;',
			'  margin: 0 0 10px;',
			'  border-radius: 8px;',
			'  border: 1px solid var(--dsw-alias-border-l1);',
			'  background: var(--dsw-alias-bg-layer-1);',
			'  font-size: 13px;',
			'  line-height: 20px;',
			'  color: var(--dsw-alias-label-secondary);',
			'  animation: thk-fade-in .25s ease-out;',
			'}',
			'.thk-flow-plan { font: var(--dsw-font-s-strong-12, 600 12px sans-serif); color: var(--dsw-alias-brand-primary); }',
			'.thk-flow-body { white-space: pre-wrap; word-break: break-word; }',
			'.thk-flow-note { display: flex; align-items: center; gap: 6px; padding: 6px 12px; margin: 0 0 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); opacity: .8; animation: thk-fade-in .25s ease-out; }',
			'@keyframes thk-fade-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }',
			'/* 设置页 */',
			'.thk-settings { display: flex; flex-direction: column; gap: 4px; width: 100%; }',
			'.thk-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }',
			'.thk-setting-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }',
			'.thk-setting-title { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); }',
			'.thk-setting-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); opacity: .8; }',
			'.thk-toggle { position: relative; display: inline-block; width: 36px; height: 20px; flex: none; }',
			'.thk-toggle input { opacity: 0; width: 0; height: 0; }',
			'.thk-toggle-slider { position: absolute; cursor: pointer; inset: 0; background: var(--dsw-alias-border-l2); border-radius: 999px; transition: background .15s ease; }',
			'.thk-toggle-slider:before { content: ""; position: absolute; height: 16px; width: 16px; left: 2px; top: 2px; background: #fff; border-radius: 50%; transition: transform .15s ease; }',
			'.thk-toggle input:checked + .thk-toggle-slider { background: var(--dsw-alias-brand-primary); }',
			'.thk-toggle input:checked + .thk-toggle-slider:before { transform: translateX(16px); }',
			'.thk-number { width: 72px; padding: 4px 8px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }',
			'.thk-select { width: 260px; max-width: 50%; padding: 5px 8px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }',
			'.thk-save-hint { font-size: 12px; color: var(--dsw-alias-state-success-primary); min-height: 16px; }',
		'.thk-retry { margin-top: 8px; padding: 4px 12px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; cursor: pointer; }',
		].join('\n');

		/** POST /thinking-summary/api/<method> → {ok, value} */
		async function api(method, payload) {
			let response;
			try {
				response = await fetch(`/thinking-summary/api/${method}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload ?? {}),
				});
			} catch (error) {
				throw new Error(error instanceof Error ? error.message : String(error));
			}
			const parsed = await response.json().catch(() => null);
			if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
				throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
			}
			return parsed.value;
		}

		function parseRowKey(key) {
			if (typeof key !== 'string') return null;
			// DSH 0.2.2 wraps process rows as JSON [nodeKey, "process"].
			if (key.startsWith('[')) {
				try { const grouped = JSON.parse(key); if (!Array.isArray(grouped) || typeof grouped[0] !== 'string') return null; key = grouped[0]; } catch { return null; }
			}
			const match = /^(\d+):([a-z-]+)(\d+):(\d+)$/.exec(key);
			if (match === null) return null;
			if (match[2] !== 'assistant-step') return null;
			if (match[2].length !== Number(match[1])) return null;
			return { turn: Number(match[3]), step: Number(match[4]) };
		}

		function truncate(text, max) {
			if (typeof text !== 'string') return '';
			return text.length > max ? text.slice(0, max) + '…' : text;
		}

		const inject = ['slots', 'timer'];

		function apply(ctx) {
			const styleTag = document.createElement('style');
			styleTag.dataset.plugin = 'dsh-thinking-summary';
			styleTag.textContent = CSS;
			document.head.appendChild(styleTag);
			ctx.effect(() => () => styleTag.remove());

			const slots = ctx.get('slots');
			if (slots === undefined) return;

			/* ---------- 设置页 ---------- */
			const SettingsPage = () => {
				const [prefs, setPrefs] = React.useState(null);
				const [loadError, setLoadError] = React.useState(null);
				const [hint, setHint] = React.useState('');
				const [busy, setBusy] = React.useState(false);
				const [attempt, setAttempt] = React.useState(0);
				const [providers, setProviders] = React.useState([]);
				const [models, setModels] = React.useState([]);
				const [modelsError, setModelsError] = React.useState('');
				const [effective, setEffective] = React.useState(null);
				const [revision, setRevision] = React.useState(0);

				React.useEffect(() => {
					let disposed = false;
					setLoadError(null);
					Promise.all([api('settings.get'), api('providers.list')]).then(([res, catalog]) => {
						if (disposed) return;
						if (res !== null && typeof res === 'object' && res.value !== null && typeof res.value === 'object') {
							setPrefs(res.value);
							setRevision(res.revision ?? 0);
							setProviders(catalog.providers ?? []);
							api('model.current').then((value) => { if (!disposed) setEffective(value); }).catch(() => { if (!disposed) setEffective({ status: 'error', message: '无法读取当前摘要模型' }); });
						} else {
							setLoadError('返回数据格式异常');
						}
					}).catch((error) => {
						if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
					});
					return () => { disposed = true; };
				}, [attempt]);

				React.useEffect(() => {
					let disposed = false;
					setModels([]); setModelsError('');
					if (prefs?.providerId) api('models.list', { providerId: prefs.providerId }).then((value) => { if (!disposed) setModels(value.models ?? []); }).catch((error) => { if (!disposed) setModelsError(error.message); });
					return () => { disposed = true; };
				}, [prefs?.providerId]);

				const patch = async (next) => {
					if (busy || prefs === null) return;
					setBusy(true);
					setHint('');
					const previous = prefs;
					setPrefs({ ...prefs, ...next });
					try {
						const res = await api('settings.update', { patch: next, expectedRevision: revision });
						if (res !== null && typeof res === 'object' && res.value !== null && typeof res.value === 'object') setPrefs(res.value);
						setRevision(res.revision ?? revision);
						setHint('已保存，对后续摘要调用生效');
						setEffective(await api('model.current').catch(() => ({ status: 'error', message: '无法读取当前摘要模型' })));
					} catch (error) {
						setPrefs(previous);
						api('settings.get').then((res) => { setPrefs(res.value); setRevision(res.revision ?? 0); }).catch(() => {});
						setHint(`保存失败：${error instanceof Error ? error.message : String(error)}`);
					} finally {
						setBusy(false);
					}
				};

				if (prefs === null) {
				if (loadError !== null) {
					return React.createElement('div', { className: 'thk-settings' },
						React.createElement('div', { className: 'thk-setting-desc' }, `加载失败：${loadError}`),
						React.createElement('button', { type: 'button', className: 'thk-retry', onClick: () => setAttempt((a) => a + 1) }, '重试'),
					);
				}
				return React.createElement('div', { className: 'thk-settings' }, '加载中…');
			}

				const row = (title, desc, control) => React.createElement('div', { className: 'thk-setting-row' },
					React.createElement('div', { className: 'thk-setting-info' },
						React.createElement('div', { className: 'thk-setting-title' }, title),
						React.createElement('div', { className: 'thk-setting-desc' }, desc),
					),
					control,
				);

				const toggle = (checked, onChange) => React.createElement('label', { className: 'thk-toggle' },
					React.createElement('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
					React.createElement('span', { className: 'thk-toggle-slider' }),
				);
				const numeric = (key, fallback, min, max) => React.createElement('input', {
					className: 'thk-number', type: 'number', min, max, step: 1, disabled: busy,
					key: key + ':' + (prefs[key] ?? fallback), defaultValue: prefs[key] ?? fallback,
					onBlur: (event) => {
						const value = Number(event.currentTarget.value);
						if (!Number.isInteger(value) || value < min || value > max) { event.currentTarget.value = String(prefs[key] ?? fallback); setHint(`请输入 ${min}–${max} 的整数`); return; }
						if (value !== (prefs[key] ?? fallback)) patch({ [key]: value });
					},
				});

				return React.createElement('div', { className: 'thk-settings' },
					row('摘要提供商', '使用 DSH 中已配置的连接；不需要在这里填写密钥', React.createElement('select', { className: 'thk-select', value: prefs.providerId ?? '', disabled: busy, onChange: (event) => patch({ providerId: event.target.value, modelId: '' }) },
						React.createElement('option', { value: '' }, '自动选择 Flash 模型'),
						prefs.providerId && !providers.some((p) => p.id === prefs.providerId) ? React.createElement('option', { value: prefs.providerId }, prefs.providerId + '（不可用）') : null,
						...providers.map((p) => React.createElement('option', { key: p.id, value: p.id }, p.name === p.id ? p.id : `${p.name} (${p.id})`)),
					)),
					row('摘要模型', '手动选择后不会静默切换到其他提供商或模型', React.createElement('select', { className: 'thk-select', value: prefs.modelId ?? '', disabled: busy || !prefs.providerId, onChange: (event) => patch({ modelId: event.target.value }) },
						React.createElement('option', { value: '' }, '自动选择该提供商的 Flash 模型'),
						prefs.modelId && !models.some((m) => m.id === prefs.modelId) ? React.createElement('option', { value: prefs.modelId }, prefs.modelId + '（未在列表中）') : null,
						...models.map((m) => React.createElement('option', { key: m.id, value: m.id }, m.name === m.id ? m.id : `${m.name} (${m.id})`)),
					)),
					modelsError ? React.createElement('div', { className: 'thk-setting-desc' }, modelsError) : null,
					row('当前生效模型', '摘要解读不写入主任务上下文', React.createElement('span', { className: 'thk-setting-desc' }, effective?.status === 'ok' ? `${effective.provider} / ${effective.model}` : effective?.message ?? '正在读取…')),
					row('摘要思考模式', '支持 off 时关闭思考，其余使用提供商默认设置', React.createElement('span', null,
						effective?.status !== 'ok' ? '自动' : effective.reasoningPolicy === 'off' ? '关闭（off）' : '提供商默认')),
					row('输出 token 上限', '64–8192；默认 500。输入后移开焦点保存', numeric('maxOutputTokens', 500, 64, 8192)),
					row('最大尝试次数', '包含首次调用；1 表示失败不重试，默认 2，最多 5', numeric('maxAttempts', 2, 1, 5)),
					row('在 Deep diving 右侧显示计划', '每段思考结束后，把“接下来打算做什么”显示在原生状态文字的右侧', toggle(prefs.planSuffix === true, (value) => patch({ planSuffix: value }))),
					row('显示思考摘要卡片', '在消息流中每段思考的正下方插入中文摘要卡片', toggle(prefs.flowCards === true, (value) => patch({ flowCards: value }))),
					row('计划长度上限', '超出时按标点边界截断并加省略号（12–48 字）', React.createElement('input', {
						type: 'number',
						className: 'thk-number',
						min: 12,
						max: 48,
						value: prefs.planMaxChars ?? 36,
						onChange: (event) => {
							const value = Number(event.target.value);
							if (Number.isFinite(value) && value >= 12 && value <= 48) patch({ planMaxChars: value });
						},
					})),
					React.createElement('div', { className: 'thk-save-hint' }, hint),
				);
			};

			slots.inject('settings.section', () => slots.register(
				{ name: 'settings.section', id: 'thinking-summary', order: 90, label: '思考摘要' },
				(props) => React.createElement(SettingsPage, props),
			));

			/* ---------- 会话级 Sidecar（不可见） ---------- */
			const StatusSidecar = (props) => {
				const sessionId = props.sessionId;

				// 控制器 A：把“下一步计划”追加到原生 Deep diving 文字右侧
				React.useEffect(() => {
					if (sessionId === undefined || sessionId === null) return;
					const sid = String(sessionId);
					let disposed = false;
					let pendingTimer = null;
					let suffixEl = null;

					const removeSuffix = () => {
						if (suffixEl !== null && suffixEl.parentNode !== null) suffixEl.parentNode.removeChild(suffixEl);
						suffixEl = null;
					};

					const ensureSuffix = (hostEl, text) => {
						if (suffixEl === null || suffixEl.parentNode !== hostEl) {
							removeSuffix();
							suffixEl = document.createElement('span');
							suffixEl.className = 'thk-plan-suffix';
							suffixEl.setAttribute('data-thk', 'plan');
							hostEl.appendChild(suffixEl);
						}
						if (suffixEl.textContent !== text) suffixEl.textContent = text;
					};

					const tick = async () => {
						if (disposed) return;
						let res = null;
						try {
							res = await api('live-status', { sessionId: sid });
						} catch { res = null; }
						if (disposed) return;
						const hostEl = document.querySelector('[data-chat-flow] [role="status"][aria-live="polite"]');
						if (hostEl === null) {
							removeSuffix();
						} else if (res !== null && typeof res === 'object' && res.working === true && typeof res.plan === 'string' && res.plan !== '') {
							ensureSuffix(hostEl, ` · ${res.plan}`);
						} else {
							removeSuffix();
						}
						pendingTimer = ctx.timeout(tick, 800);
					};

					tick();
					return () => {
						disposed = true;
						if (pendingTimer !== null) pendingTimer();
						removeSuffix();
					};
				}, [sessionId]);

				// 控制器 B：消息流内，每个思考步骤完成后在其下方插入摘要卡片
				React.useEffect(() => {
					if (sessionId === undefined || sessionId === null) return;
					const sid = String(sessionId);
					let disposed = false;
					const entries = new Map();

					const removeCard = (entry) => {
						if (entry.element !== null && entry.element.parentNode !== null) entry.element.parentNode.removeChild(entry.element);
						entry.element = null;
					};

					const buildCard = (plan, summary) => {
						const root = document.createElement('div');
						root.className = 'thk-flow-card';
						if (typeof plan === 'string' && plan !== '') {
							const planLine = document.createElement('div');
							planLine.className = 'thk-flow-plan';
							planLine.textContent = plan;
							root.appendChild(planLine);
						}
						const body = document.createElement('div');
						body.className = 'thk-flow-body';
						body.textContent = summary;
						root.appendChild(body);
						return root;
					};

					const buildNote = (text) => {
						const note = document.createElement('div');
						note.className = 'thk-flow-note';
						note.textContent = text;
						return note;
					};

					const place = (entry) => {
						if (entry.element !== null && entry.row !== null && entry.row.parentNode !== null && (entry.element.parentNode !== entry.row.parentNode || entry.row.nextSibling !== entry.element)) {
							entry.row.parentNode.insertBefore(entry.element, entry.row.nextSibling);
						}
					};

					const pollStep = (entry) => {
						if (entry.polling || disposed) return;
						entry.polling = true;
						api('step-summary', { sessionId: sid, turn: entry.turn, step: entry.step }).then((res) => {
							entry.polling = false;
							if (disposed || !entries.has(entry.key)) return;
							if (res !== null && typeof res === 'object') {
								if (res.status === 'ok') {
									if (entry.phase !== 'ok') {
										removeCard(entry);
										entry.element = buildCard(typeof res.plan === 'string' ? res.plan : '', typeof res.summary === 'string' ? res.summary : '');
										entry.phase = 'ok';
										place(entry);
									}
									return;
								}
								if (res.status === 'computing') {
									if (entry.phase !== 'computing') {
										removeCard(entry);
										entry.element = buildNote('正在生成思考摘要…');
										entry.phase = 'computing';
										place(entry);
									}
									return;
								}
								if (res.status === 'none') {
									removeCard(entry);
									entry.phase = 'done';
									return;
								}
								if (res.status === 'error') {
									removeCard(entry);
									entry.element = buildNote(`思考摘要生成失败：${truncate(typeof res.message === 'string' ? res.message : '未知错误', 60)}`);
									entry.phase = 'done';
									place(entry);
									return;
								}
								return;
							}
							entry.phase = 'done';
						}).catch(() => {
							entry.polling = false;
						});
					};

					const scan = () => {
						if (disposed) return;
						const root = document.querySelector('[data-chat-flow]');
						if (root === null) return;
						const rows = root.querySelectorAll('[data-chat-flow-kind="assistant-step"]');
						const candidates = new Map();
						for (const row of rows) {
							const parsed = parseRowKey(row.getAttribute('data-chat-node-key') || row.getAttribute('data-chat-flow-key') || '');
							if (parsed === null) continue;
							const key = `${parsed.turn}#${parsed.step}`;
							const previous = candidates.get(key);
							// A step can have separate process and reply rows. Anchor
							// its summary to the process row, never duplicate it.
							if (!previous || (row.getAttribute('data-chat-group-part') === 'process' && previous.row.getAttribute('data-chat-group-part') !== 'process')) candidates.set(key, { row, parsed });
						}
						const seen = new Set();
						for (const { row, parsed } of candidates.values()) {
							const key = `${parsed.turn}#${parsed.step}`;
							seen.add(key);
							let entry = entries.get(key);
							if (entry === undefined) {
								entry = { key, turn: parsed.turn, step: parsed.step, row, element: null, phase: 'pending', polling: false };
								entries.set(key, entry);
							} else {
								entry.row = row;
							}
							// React can remove or replace neighboring DOM nodes.
							// Reattach cached cards on every scan without regenerating.
							place(entry);
							if (entry.phase === 'pending' || entry.phase === 'computing') pollStep(entry);
						}
						for (const [key, entry] of entries) {
							if (!seen.has(key)) {
								removeCard(entry);
								entries.delete(key);
							}
						}
					};

					scan();
					const stopScan = ctx.interval(scan, 1200);
					return () => {
						disposed = true;
						stopScan();
						for (const entry of entries.values()) removeCard(entry);
						entries.clear();
					};
				}, [sessionId]);

				return null;
			};

			slots.inject('conversation.input.dock', () => slots.register(
				{ name: 'conversation.input.dock', id: 'thinking-plan-suffix', order: 5, label: '思考计划' },
				(props) => React.createElement(StatusSidecar, props),
			));
		}

		exports.name = 'dsh-thinking-summary';
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
