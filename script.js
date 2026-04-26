        // Theme logic
        const themeToggle = document.getElementById('theme-toggle');
        const applyTheme = (isDark) => {
            if (isDark) {
                document.documentElement.classList.add('dark');
                localStorage.setItem('prepify_theme', 'dark');
                themeToggle.checked = true;
            } else {
                document.documentElement.classList.remove('dark');
                localStorage.setItem('prepify_theme', 'light');
                themeToggle.checked = false;
            }
            setTimeout(() => {
                renderDashboard();
                if (document.getElementById('view-dashboard').classList.contains('active')) {
                    renderPracticeChart();
                }
            }, 50); // Redraw charts
        }
        themeToggle.addEventListener('change', (e) => applyTheme(e.target.checked));
        if (localStorage.getItem('prepify_theme') === 'dark') applyTheme(true);

        // Helpers
        const getLocalDateStr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const formatDatePretty = (isoStr) => {
            const d = new Date(isoStr);
            return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getFullYear()}`;
        };

        const DB_KEY = 'prepify_db';

        // Format number utility
        function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    return num.toString();
}


        // Supabase Init with provided credentials
        const { createClient } = supabase;
        const supabaseClient = createClient(
            'https://ctamdmmmgcvluuarbspe.supabase.co',
            'sb_publishable_xhzDjPTIpUzR3nGkyGy8tQ_lsBoNIjd'
        );
        let currentUser = null;

        // Ensure UUID generation compatible with Supabase relational UUID columns
        const generateId = () => {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                return crypto.randomUUID();
            }
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        };

        const AppStorage = {
            memory: null,
            load: function () {
                try {
                    const data = localStorage.getItem(DB_KEY);
                    if (data) this.memory = JSON.parse(data);
                } catch (e) { }
                if (!this.memory) { this.memory = this.getDefaultState(); this.saveLocal(); }
                if (!this.memory.practiceLogs) this.memory.practiceLogs = {};
                if (!this.memory.tasks) this.memory.tasks = [];
                if (!this.memory.deletedTags) this.memory.deletedTags = [];
            },

            // New logic: Fetching structured data from multiple Supabase tables
            loadFromSupabase: async function () {
                if (!currentUser) return;
                try {
                    // Fetch Practice Logs
                    const { data: pLogs, error: pError } = await supabaseClient.from('practice_logs').select('*').eq('user_id', currentUser.id);
                    this.memory.practiceLogs = {};
                    if (pLogs) {
                        pLogs.forEach(log => {
                            this.memory.practiceLogs[log.date] = {
                                p: log.physics || 0, c: log.chemistry || 0, m: log.maths || 0
                            };
                        });
                    }

                    // Fetch Mock Tests
                    const { data: mTests, error: mError } = await supabaseClient.from('mock_tests').select('*').eq('user_id', currentUser.id);
                    this.memory.mocks = [];
                    if (mTests) {
                        mTests.forEach(m => {
                            this.memory.mocks.push({
                                id: m.id,
                                name: m.name,
                                date: m.test_date,
                                maxMarks: m.total_marks,
                                correct: m.correct,
                                incorrect: m.incorrect,
                                skipped: m.skipped,
                                timeTaken: ((m.time_hours || 0) * 60) + (m.time_minutes || 0)
                            });
                        });
                    }

                    // Fetch Revision Topics
                    const { data: rTopics, error: rError } = await supabaseClient.from('revision_topics').select('*').eq('user_id', currentUser.id);
                    this.memory.topics = [];
                    if (rTopics) {
                        rTopics.forEach(t => {
                            this.memory.topics.push({
                                id: t.id,
                                name: t.topic_name,
                                firstDate: t.first_revision_date,
                                lastReviewed: t.last_reviewed_date || t.first_revision_date,
                                reviewCount: t.completed_revisions,
                                maxRevisions: t.total_revisions,
                                completed: t.is_completed
                            });
                        });
                    }

                    // Fetch Tasks
                    const { data: tData, error: tError } = await supabaseClient.from('tasks').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: true });
                    this.memory.tasks = [];
                    if (tData) {
                        tData.forEach(t => {
                            this.memory.tasks.push({
                                id: t.id,
                                text: t.task_text,
                                completed: t.is_completed,
                                created_at: t.created_at,
                                completed_at: t.completed_at || null
                            });
                        });
                    }

                    this.saveLocal();
                    updateLogic();
                } catch (err) {
                    console.error("Supabase load error:", err);
                }
            },
            saveLocal: function () {
                try { localStorage.setItem(DB_KEY, JSON.stringify(this.memory)); } catch (e) { }
            },
            getDefaultState: function () { return { topics: [], practiceLogs: {}, mocks: [], tasks: [], deletedTags: [] }; },
            get: function () { if (!this.memory) this.load(); return this.memory; },
            reset: function () {
                this.memory = this.getDefaultState();
                this.saveLocal();
            }
        };

        // --- Backend Sync Functions --- //

        async function saveTask(taskText, taskDateStr = null) {
            const db = AppStorage.get();
            let finalDate = new Date().toISOString();

            // Apply selected date while preserving current time for sorting accuracy
            if (taskDateStr) {
                const parts = taskDateStr.split('-');
                if (parts.length === 3) {
                    const now = new Date();
                    const customDate = new Date(parts[0], parts[1] - 1, parts[2], now.getHours(), now.getMinutes(), now.getSeconds());
                    finalDate = customDate.toISOString();
                }
            }

            const newTask = { id: generateId(), text: taskText, completed: false, created_at: finalDate };
            db.tasks.push(newTask);
            AppStorage.saveLocal();
            updateLogic();

            if (currentUser) {
                await supabaseClient.from('tasks').insert({
                    id: newTask.id,
                    user_id: currentUser.id,
                    task_text: newTask.text,
                    is_completed: false,
                    created_at: finalDate
                });
            }
        }

        // Guard to prevent double-toggle from cloneNode/drag-drop re-render race condition
        const _toggleLocks = new Set();

        window.toggleTask = async function (id) {
            // Debounce: ignore if already toggled within last 300ms
            if (_toggleLocks.has(id)) return;
            _toggleLocks.add(id);
            setTimeout(() => _toggleLocks.delete(id), 300);

            const db = AppStorage.get();
            const task = db.tasks.find(t => t.id === id);
            if (task) {
                const wasCompleted = task.completed;
                task.completed = !task.completed;
                // Track completion date: set when completing, clear when uncompleting
                if (!wasCompleted && task.completed) {
                    task.completed_at = new Date().toISOString();
                } else if (wasCompleted && !task.completed) {
                    task.completed_at = null;
                }
                AppStorage.saveLocal();
                updateLogic();

                // Play ting sound on task completion
                if (!wasCompleted && task.completed) {
                    playTaskCompleteSound();
                }

                if (currentUser) {
                    await supabaseClient.from('tasks').update({
                        is_completed: task.completed
                    }).eq('id', id);
                }
            }
        };

        // Task completion sound (pleasant single ting)
        function playTaskCompleteSound() {
            try {
                const soundEnabled = localStorage.getItem('prepify_sound') !== 'off';
                if (!soundEnabled) return;
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.setValueAtTime(1046.5, ctx.currentTime); // High-C
                osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.4);
                osc.onended = () => ctx.close();
            } catch (e) { /* Audio not supported */ }
        }

        async function savePracticeLog(dateStr, p, c, m) {
            // Update Local
            AppStorage.memory.practiceLogs[dateStr] = { p, c, m };
            AppStorage.saveLocal();
            updateLogic();

            // Update DB
            if (currentUser) {
                await supabaseClient.from('practice_logs').upsert({
                    user_id: currentUser.id,
                    date: dateStr,
                    physics: p,
                    chemistry: c,
                    maths: m
                }, { onConflict: 'user_id, date' });
            }
        }

        async function saveMockTest(mockData, isEdit) {
            // Update Local
            if (isEdit) {
                const idx = AppStorage.memory.mocks.findIndex(m => m.id === mockData.id);
                AppStorage.memory.mocks[idx] = mockData;
            } else {
                AppStorage.memory.mocks.push(mockData);
            }
            AppStorage.saveLocal();
            updateLogic();

            // Update DB
            if (currentUser) {
                const dbPayload = {
                    user_id: currentUser.id,
                    name: mockData.name,
                    test_date: mockData.date,
                    total_marks: mockData.maxMarks,
                    correct: mockData.correct,
                    incorrect: mockData.incorrect,
                    skipped: mockData.skipped,
                    time_hours: Math.floor(mockData.timeTaken / 60),
                    time_minutes: mockData.timeTaken % 60
                };

                if (isEdit) {
                    await supabaseClient.from('mock_tests').update(dbPayload).eq('id', mockData.id);
                } else {
                    dbPayload.id = mockData.id;
                    await supabaseClient.from('mock_tests').insert(dbPayload);
                }
            }
        }

        async function saveTopic(topicData, isEdit) {
            // Update Local
            if (isEdit) {
                const idx = AppStorage.memory.topics.findIndex(t => t.id === topicData.id);
                AppStorage.memory.topics[idx] = topicData;
            } else {
                AppStorage.memory.topics.push(topicData);
            }
            AppStorage.saveLocal();
            updateLogic();

            // Update DB
            if (currentUser) {
                const dbPayload = {
                    user_id: currentUser.id,
                    topic_name: topicData.name,
                    first_revision_date: topicData.firstDate,
                    last_reviewed_date: topicData.lastReviewed,
                    total_revisions: topicData.maxRevisions,
                    completed_revisions: topicData.reviewCount,
                    is_completed: topicData.reviewCount >= topicData.maxRevisions
                };

                if (isEdit) {
                    await supabaseClient.from('revision_topics').update(dbPayload).eq('id', topicData.id);
                } else {
                    dbPayload.id = topicData.id;
                    await supabaseClient.from('revision_topics').insert(dbPayload);
                }
            }
        }

        async function executeDelete(type, id) {
            const db = AppStorage.get();
            // Local & DB Delete
            if (type === 'practice') {
                delete db.practiceLogs[id];
                if (currentUser) await supabaseClient.from('practice_logs').delete().eq('user_id', currentUser.id).eq('date', id);
            } else if (type === 'topic') {
                db.topics = db.topics.filter(t => t.id !== id);
                if (currentUser) await supabaseClient.from('revision_topics').delete().eq('id', id);
            } else if (type === 'mock') {
                db.mocks = db.mocks.filter(m => m.id !== id);
                if (currentUser) await supabaseClient.from('mock_tests').delete().eq('id', id);
            } else if (type === 'task') {
                db.tasks = db.tasks.filter(t => t.id !== id);
                if (currentUser) await supabaseClient.from('tasks').delete().eq('id', id);
            }
            AppStorage.saveLocal();
            updateLogic();
        }

        async function executeClearData() {
            AppStorage.reset();
            updateLogic();
            if (currentUser) {
                await supabaseClient.from('practice_logs').delete().eq('user_id', currentUser.id);
                await supabaseClient.from('mock_tests').delete().eq('user_id', currentUser.id);
                await supabaseClient.from('revision_topics').delete().eq('user_id', currentUser.id);
                await supabaseClient.from('tasks').delete().eq('user_id', currentUser.id);
            }
        }

        // Revision Intervals: First→+3→+7→+15→+30→+60→+120 days (max 6 revisions)
        const REVISION_INTERVALS = [3, 7, 15, 30, 60, 120];
        const MAX_REVISIONS = 6;

        function getNextDueDate(lastReviewedDate, reviewCount) {
            if (!lastReviewedDate || reviewCount >= MAX_REVISIONS) return null;
            let date = new Date(lastReviewedDate);
            date.setDate(date.getDate() + REVISION_INTERVALS[reviewCount]);
            date.setHours(0, 0, 0, 0);
            return date;
        }

        function isDueToday(dueDate) {
            if (!dueDate) return false;
            let today = new Date();
            today.setHours(0, 0, 0, 0);
            return dueDate.getTime() <= today.getTime();
        }

        function updateLogic() {
            renderHome();
            renderDashboard();
            if (document.getElementById('view-dashboard').classList.contains('active')) {
                renderPracticeChart();
                renderTaskCompletionChart();
                renderTaskHeatmap();
                renderTaskPieChart();
                renderRadarChart();
                renderRollingAvgChart();
                renderHealthScore();
            }
            renderMocks();
            renderRevision();
            renderTasks();
        }

        // Chart.js Instances Tracking
        let practiceChartInst = null;
        let mockChartInst = null;
        let mockTimeChartInst = null;
        let pieChartInst = null;
        let taskCompletionChartInst = null;
        let taskPieChartInst = null;
        let radarChartInst = null;
        let rollingChartInst = null;

        // Chart Renderers (using Chart.js)
        function renderChartJsLine(canvasId, labels, dataPoints, dataLabel, isDark, customColor = null) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const ctx = canvas.getContext('2d');

            if (canvasId === 'practiceLineChart' && practiceChartInst) practiceChartInst.destroy();
            if (canvasId === 'lineChart' && mockChartInst) mockChartInst.destroy();
            if (canvasId === 'timeChart' && mockTimeChartInst) mockTimeChartInst.destroy();
            if (canvasId === 'taskCompletionChart' && taskCompletionChartInst) taskCompletionChartInst.destroy();
            if (canvasId === 'taskPieChart' && taskPieChartInst) taskPieChartInst.destroy();

            const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
            const textColor = isDark ? '#9ca3af' : '#6b7280';
            const lineColor = customColor || (isDark ? '#ffffff' : '#000000');
            const bgColor = customColor
                ? (isDark ? `${customColor}33` : `${customColor}33`)
                : (isDark ? 'rgba(34, 197, 94, 0.15)' : 'rgba(34, 197, 94, 0.2)');

            const config = {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: dataLabel,
                        data: dataPoints,
                        borderColor: lineColor,
                        backgroundColor: bgColor,
                        borderWidth: 2,
                        fill: canvasId === 'practiceLineChart' || canvasId === 'taskCompletionChart',
                        pointBackgroundColor: lineColor,
                        pointRadius: 4,
                        pointHoverRadius: 6,
                        tension: 0.3
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: isDark ? '#1e293b' : '#ffffff',
                            titleColor: isDark ? '#ffffff' : '#000000',
                            bodyColor: isDark ? '#cbd5e1' : '#475569',
                            borderColor: isDark ? '#334155' : '#e2e8f0',
                            borderWidth: 1,
                            padding: 10,
                            displayColors: false,
                            callbacks: {
                                label: function (context) {
                                    let label = context.dataset.label || '';
                                    if (label) {
                                        label += ' : ';
                                    }
                                    if (context.parsed.y !== null) {
                                        label += parseFloat(context.parsed.y.toFixed(2));
                                        if (context.dataset.label === 'Score') label += '%';
                                    }
                                    return label;
                                }
                            }
                        }
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: textColor, maxTicksLimit: 6 } },
                        y: { grid: { color: gridColor }, ticks: { color: textColor, beginAtZero: true } }
                    }
                }
            };

            if (canvasId === 'practiceLineChart') practiceChartInst = new Chart(ctx, config);
            if (canvasId === 'lineChart') mockChartInst = new Chart(ctx, config);
            if (canvasId === 'timeChart') mockTimeChartInst = new Chart(ctx, config);
            if (canvasId === 'taskCompletionChart') taskCompletionChartInst = new Chart(ctx, config);
            if (canvasId === 'taskPieChart') taskPieChartInst = new Chart(ctx, config);
        }

        function renderChartJsPie(canvasId, p, c, m, isDark) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const ctx = canvas.getContext('2d');

            if (pieChartInst) pieChartInst.destroy();

            const total = p + c + m;
            const data = total === 0 ? [1] : [p, c, m];
            const bgColors = total === 0
                ? [(isDark ? '#334155' : '#e5e7eb')]
                : ['#ef4444', '#22c55e', '#3b82f6'];
            const labels = total === 0 ? ['No Data'] : ['Physics', 'Chemistry', 'Maths'];

            pieChartInst = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: bgColors,
                        borderWidth: isDark ? 1 : 1,
                        borderColor: isDark ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.8)',
                        hoverOffset: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '65%',
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            enabled: total > 0,
                            backgroundColor: isDark ? '#1e293b' : '#ffffff',
                            titleColor: isDark ? '#ffffff' : '#000000',
                            bodyColor: isDark ? '#cbd5e1' : '#475569',
                            borderColor: isDark ? '#334155' : '#e2e8f0',
                            borderWidth: 1
                        }
                    }
                }
            });
        }

        // HOME TAB (Log Practice)
        function renderHome() {
            const db = AppStorage.get();
            const historyContainer = document.getElementById('practice-history-list');
            historyContainer.innerHTML = '';
            const logKeys = Object.keys(db.practiceLogs || {}).sort((a, b) => new Date(b) - new Date(a));
            if (logKeys.length === 0) {
                historyContainer.innerHTML = `<p class="text-xs text-center text-gray-400 py-2 animate-pulse">No practice logged yet.</p>`;
            } else {
                logKeys.forEach((dateStr, index) => {
                    const lg = db.practiceLogs[dateStr];
                    const totalDaily = (lg.p || 0) + (lg.c || 0) + (lg.m || 0);
                    const perc = Math.round((totalDaily / 30) * 100);
                    const d = new Date(dateStr);
                    const prettyDate = `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'long' })} ${d.getFullYear()} [ ${d.toLocaleDateString('en-US', { weekday: 'long' })} ]`;
                    historyContainer.innerHTML += `
                    <div class="bg-white dark:bg-gray-800/80 rounded-2xl p-4 flex flex-col gap-4 shadow-md border border-gray-100 dark:border-gray-700/60 transition-all hover:-translate-y-1 hover:shadow-lg opacity-0 animate-list-item-in relative overflow-hidden group" style="animation-delay: ${index * 60}ms">
                        <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/5 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]"></div>
                        
                        <div class="flex justify-between items-center relative z-10 border-b border-gray-100 dark:border-gray-700/50 pb-3">
                            <div>
                                <div class="font-extrabold text-sm text-black dark:text-white mb-1 flex items-center gap-2">
                                    ${prettyDate}
                                    <span class="text-[9px] font-black px-1.5 py-0.5 rounded ${perc >= 100 ? 'bg-green-500 text-white shadow-sm' : 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-400'}">${perc}%</span>
                                </div>
                                <div class="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1"><svg class="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg> Total Qs: ${totalDaily}</div>
                            </div>
                            <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onclick="openEditPractice('${dateStr}')" class="w-8 h-8 flex items-center justify-center bg-gray-50 dark:bg-gray-700 rounded-full text-gray-500 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors active:scale-95 border border-gray-200 dark:border-gray-600">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                                </button>
                                <button onclick="openDeleteConfirm('practice', '${dateStr}', 'Delete Practice Log?', 'Are you sure you want to delete this log?')" class="w-8 h-8 flex items-center justify-center bg-red-50 dark:bg-red-900/30 rounded-full text-red-500 hover:bg-red-100 dark:hover:bg-red-800/50 transition-colors active:scale-95 border border-red-100 dark:border-red-900/50">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                </button>
                            </div>
                        </div>

                        <div class="grid grid-cols-3 gap-3 relative z-10">
                            <div class="flex items-center gap-3">
                                <div class="w-1.5 h-8 rounded-sm bg-red-500"></div>
                                <div>
                                    <div class="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Physics</div>
                                    <div class="text-sm font-black text-black dark:text-white">${lg.p}</div>
                                </div>
                            </div>
                            <div class="flex items-center gap-3">
                                <div class="w-1.5 h-8 rounded-sm bg-green-500"></div>
                                <div>
                                    <div class="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Chemistry</div>
                                    <div class="text-sm font-black text-black dark:text-white">${lg.c}</div>
                                </div>
                            </div>
                            <div class="flex items-center gap-3">
                                <div class="w-1.5 h-8 rounded-sm bg-blue-500"></div>
                                <div>
                                    <div class="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Maths</div>
                                    <div class="text-sm font-black text-black dark:text-white">${lg.m}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
                });
            }
        }

        // DASHBOARD TAB (Analytics)
        function renderDashboard() {
            const db = AppStorage.get();
            const isDark = document.documentElement.classList.contains('dark');
            let tp = 0, tc = 0, tm = 0;
            let greenDaysCount = 0;

            // Use completed_at (the actual date task was marked done) for all date-based stats
            const getCompletionDateStr = (t) => {
                const src = t.completed_at || t.created_at;
                return src ? getLocalDateStr(new Date(src)) : null;
            };

            const getTasksCompletedOnDate = (dStr) => {
                return (db.tasks || []).filter(t => {
                    if (!t.completed) return false;
                    return getCompletionDateStr(t) === dStr;
                }).length;
            };

            Object.keys(db.practiceLogs || {}).forEach(dateStr => {
                const log = db.practiceLogs[dateStr];
                tp += (log.p || 0); tc += (log.c || 0); tm += (log.m || 0);
                if ((log.p || 0) >= 10 && (log.c || 0) >= 10 && (log.m || 0) >= 10) {
                    if (getTasksCompletedOnDate(dateStr) >= 5) {
                        greenDaysCount++;
                    }
                }
            });

            // Green Days update
            document.getElementById('dash-green-days').innerText = greenDaysCount;

            // 1. Streak Logic (Now requires 10+ Qs per subject AND 5+ tasks completed that day)
            let streak = 0;
            let currDate = new Date();
            const isMet = (dStr) => {
                const l = db.practiceLogs[dStr];
                const practiceMet = l && l.p >= 10 && l.c >= 10 && l.m >= 10;
                const tasksMet = getTasksCompletedOnDate(dStr) >= 5;
                return practiceMet && tasksMet;
            };
            if (isMet(getLocalDateStr(currDate))) {
                streak++; currDate.setDate(currDate.getDate() - 1);
                while (isMet(getLocalDateStr(currDate))) { streak++; currDate.setDate(currDate.getDate() - 1); }
            } else {
                currDate.setDate(currDate.getDate() - 1);
                if (isMet(getLocalDateStr(currDate))) {
                    while (isMet(getLocalDateStr(currDate))) { streak++; currDate.setDate(currDate.getDate() - 1); }
                }
            }
            document.getElementById('home-streak').innerText = `${streak} Day${streak !== 1 ? 's' : ''}`;

            // Update Header Streak too
            const headerStreak = document.getElementById('header-streak-count');
            if (headerStreak) headerStreak.innerText = streak;

            // 2. Productivity Score Logic (Points based)
            let practicePoints = (tp + tc + tm) * 100;

            let mockPoints = 0;
            if (db.mocks && db.mocks.length > 0) {
                db.mocks.forEach(m => {
                    mockPoints += (parseInt(m.correct || 0) * 100) + (parseInt(m.incorrect || 0) * -25);
                });
            }

            let revisionPoints = 0;
            (db.topics || []).forEach(t => {
                revisionPoints += (t.reviewCount || 0) * 100;
            });

            // Task Points: +100 per completed task
            let taskPoints = 0;
            const completedTasksAll = (db.tasks || []).filter(t => t.completed);
            const undoneTasksAll = (db.tasks || []).filter(t => !t.completed);
            taskPoints = (completedTasksAll.length * 100);

            let totalPoints = practicePoints + mockPoints + revisionPoints + taskPoints;
            document.getElementById('dash-prod-score').innerText = formatNumber(totalPoints);


            // Task Stat Cards
            const totalTasksAll = (db.tasks || []).length;
            const completedCount = completedTasksAll.length;
            const undoneCount = undoneTasksAll.length;
            const taskPcnt = totalTasksAll > 0 ? Math.round((completedCount / totalTasksAll) * 100) : 0;

            // Avg completed tasks per day — use completed_at date, not created_at
            const completedByDay = {};
            completedTasksAll.forEach(t => {
                const src = t.completed_at || t.created_at;
                const dStr = src ? getLocalDateStr(new Date(src)) : 'unknown';
                completedByDay[dStr] = (completedByDay[dStr] || 0) + 1;
            });
            const activeDays = Object.keys(completedByDay).length;
            const avgPerDay = activeDays > 0 ? (completedCount / activeDays).toFixed(1) : 0;

            document.getElementById('dash-tasks-completed').innerText = completedCount;
            document.getElementById('dash-tasks-pcnt').innerText = taskPcnt;
            document.getElementById('dash-tasks-per-day').innerText = avgPerDay;
            document.getElementById('dash-tasks-undone').innerText = undoneCount;

            document.getElementById('dash-total-questions').innerText = formatNumber(tp + tc + tm);

            let totalRevDone = 0;
            (db.topics || []).forEach(t => {
                totalRevDone += (t.reviewCount || 0);
            });
            document.getElementById('dash-total-revisions').innerText = totalRevDone;

            // Avg Time Per Question Logic (Mocks)
            let totalMockTime = 0;
            let totalMockQs = 0;
            if (db.mocks && db.mocks.length > 0) {
                db.mocks.forEach(m => {
                    totalMockTime += parseInt(m.timeTaken) || 0;
                    totalMockQs += (parseInt(m.correct) || 0) + (parseInt(m.incorrect) || 0) + (parseInt(m.skipped) || 0);
                });
            }
            if (totalMockQs > 0 && totalMockTime > 0) {
                let avgSecs = Math.round((totalMockTime * 60) / totalMockQs);
                if (avgSecs >= 60) {
                    let mins = Math.floor(avgSecs / 60);
                    let secs = avgSecs % 60;
                    document.getElementById('dash-avg-time').innerText = `${mins}m ${secs}s`;
                } else {
                    document.getElementById('dash-avg-time').innerText = `${avgSecs}s`;
                }
            } else {
                document.getElementById('dash-avg-time').innerText = `-`;
            }

            // 3. Completion Percentage Logic (New target is 3333 * 3 = ~10000)
            const totalGoal = 10000;
            let totalDone = tp + tc + tm;
            const prepPcnt = Math.min(100, (totalDone / totalGoal) * 100).toFixed(1);
            document.getElementById('dash-prep-pcnt').innerText = prepPcnt;

            // 4. Line Chart (Mocks)
            const emptyTrend = document.getElementById('empty-line-trend');
            const lineCanvas = document.getElementById('lineChart');

            const emptyTimeTrend = document.getElementById('empty-time-trend');
            const timeCanvas = document.getElementById('timeChart');

            if (db.mocks.length === 0) {
                emptyTrend.style.display = 'block'; lineCanvas.style.display = 'none';
                emptyTimeTrend.style.display = 'block'; timeCanvas.style.display = 'none';
            } else {
                emptyTrend.style.display = 'none'; lineCanvas.style.display = 'block';
                emptyTimeTrend.style.display = 'none'; timeCanvas.style.display = 'block';

                const mocksBase = [...db.mocks].sort((a, b) => new Date(a.date) - new Date(b.date));
                const recent = mocksBase.slice(-6);
                const points = [], labels = [], timePoints = [];
                recent.forEach((m, idx) => {
                    const max = parseInt(m.maxMarks) || 100;
                    const score = (parseInt(m.correct) * 4) - parseInt(m.incorrect);
                    points.push(parseFloat(Math.max(0, (score / max) * 100).toFixed(2)));
                    timePoints.push(parseInt(m.timeTaken) || 0);
                    labels.push(`T${idx + 1}`);
                });
                renderChartJsLine('lineChart', labels, points, 'Score', isDark);
                renderChartJsLine('timeChart', labels, timePoints, 'Time (Mins)', isDark, '#3b82f6');
            }

            // 5. Pie Chart
            renderChartJsPie('pieChart', tp, tc, tm, isDark);

            // 6. Subject Percentage Cards
            const GOAL = 3333;
            const pSubPcnt = Math.min(100, (tp / GOAL) * 100).toFixed(1);
            const cSubPcnt = Math.min(100, (tc / GOAL) * 100).toFixed(1);
            const mSubPcnt = Math.min(100, (tm / GOAL) * 100).toFixed(1);
            document.getElementById('prep-analysis').innerHTML = `
            <div class="glass-card rounded-xl p-4 text-center border-b-4 border-b-red-500 hover:scale-[1.05] transition-transform opacity-0 animate-pop-in" style="animation-delay: 150ms">
                <div class="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400 mb-1 transition-colors">Physics</div>
                <div class="text-xl font-extrabold text-black dark:text-white transition-colors">${pSubPcnt}%</div>
            </div>
            <div class="glass-card rounded-xl p-4 text-center border-b-4 border-b-green-500 hover:scale-[1.05] transition-transform opacity-0 animate-pop-in" style="animation-delay: 200ms">
                <div class="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400 mb-1 transition-colors">Chemistry</div>
                <div class="text-xl font-extrabold text-black dark:text-white transition-colors">${cSubPcnt}%</div>
            </div>
            <div class="glass-card rounded-xl p-4 text-center border-b-4 border-b-blue-500 hover:scale-[1.05] transition-transform opacity-0 animate-pop-in" style="animation-delay: 250ms">
                <div class="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400 mb-1 transition-colors">Maths</div>
                <div class="text-xl font-extrabold text-black dark:text-white transition-colors">${mSubPcnt}%</div>
            </div>
        `;

            // ══════════════════════════════════════════
            // GOAL GAP + DAYS LEFT  — Update Logic
            // ══════════════════════════════════════════
            (function updateGoalGap() {
                const TOTAL_GOAL = 10000;
                const current = tp + tc + tm;           // total questions solved
                const remaining = Math.max(0, TOTAL_GOAL - current);

                // Daily average: total Qs ÷ number of distinct practice days
                const practiceDays = Object.keys(db.practiceLogs || {}).filter(d => {
                    const l = db.practiceLogs[d];
                    return ((l.p || 0) + (l.c || 0) + (l.m || 0)) > 0;
                });
                const activePracticeDays = practiceDays.length;
                const dailyAvg = activePracticeDays > 0 ? current / activePracticeDays : 0;

                // Days needed & expected completion date
                const daysNeeded = dailyAvg > 0 ? Math.ceil(remaining / dailyAvg) : null;
                let finishDateStr = 'Not enough data yet';
                if (daysNeeded !== null && remaining > 0) {
                    const finishDate = new Date();
                    finishDate.setDate(finishDate.getDate() + daysNeeded);
                    finishDateStr = finishDate.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
                } else if (remaining <= 0) {
                    finishDateStr = '🎉 Goal already achieved!';
                }

                // Gap percentage (how much is still left)
                const gapPct = ((remaining / TOTAL_GOAL) * 100).toFixed(1);
                const donePct = Math.min(100, ((current / TOTAL_GOAL) * 100));

                // Target Date Logic
                let daysUntilTarget = 365; // default 1 year
                const targetDateInput = document.getElementById('gg-target-date');
                if (db.goalGapDate) {
                    if (targetDateInput) targetDateInput.value = db.goalGapDate;
                    const tDate = new Date(db.goalGapDate);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const diffTime = tDate - today;
                    if (diffTime > 0) {
                        daysUntilTarget = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    } else {
                        daysUntilTarget = 0; // past or today
                    }
                } else {
                    if (targetDateInput) {
                        const defaultDate = new Date();
                        defaultDate.setDate(defaultDate.getDate() + 365);
                        const y = defaultDate.getFullYear();
                        const m = String(defaultDate.getMonth() + 1).padStart(2, '0');
                        const d = String(defaultDate.getDate()).padStart(2, '0');
                        targetDateInput.value = `${y}-${m}-${d}`;
                    }
                }

                // Required daily pace to finish by target date
                const requiredPace = remaining / Math.max(1, daysUntilTarget);

                // Determine color status: green / yellow / red
                let statusColor, badgeBg, badgeBorder, badgeText, warnBg, warnBorder, warnColor, blobColor;
                let warningIcon, warningMsg, statusLabel;

                // Icons
                const iconCheck = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>';
                const iconWarn = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>';
                const iconAlert = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2.5"></circle><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4m0 4h.01"></path></svg>';
                const iconTrophy = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"></path></svg>';
                const iconChart = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>';

                if (remaining <= 0) {
                    // Completed
                    statusColor = '#4ade80';
                    badgeBg = 'rgba(34,197,94,0.2)'; badgeBorder = 'rgba(34,197,94,0.35)'; badgeText = '#4ade80';
                    warnBg = 'rgba(34,197,94,0.12)'; warnBorder = 'rgba(34,197,94,0.25)'; warnColor = '#86efac';
                    blobColor = 'radial-gradient(circle,#22c55e,transparent)';
                    warningIcon = iconTrophy; warningMsg = 'Goal complete! Outstanding achievement!';
                    statusLabel = 'Achieved';
                } else if (dailyAvg === 0) {
                    // No data
                    statusColor = '#94a3b8';
                    badgeBg = 'rgba(148,163,184,0.15)'; badgeBorder = 'rgba(148,163,184,0.3)'; badgeText = '#94a3b8';
                    warnBg = 'rgba(148,163,184,0.1)'; warnBorder = 'rgba(148,163,184,0.2)'; warnColor = '#94a3b8';
                    blobColor = 'radial-gradient(circle,#64748b,transparent)';
                    warningIcon = iconChart; warningMsg = 'Start logging practice to track your pace.';
                    statusLabel = 'No Data';
                } else if (dailyAvg >= requiredPace) {
                    // On track — GREEN
                    statusColor = '#4ade80';
                    badgeBg = 'rgba(34,197,94,0.2)'; badgeBorder = 'rgba(34,197,94,0.35)'; badgeText = '#4ade80';
                    warnBg = 'rgba(34,197,94,0.12)'; warnBorder = 'rgba(34,197,94,0.25)'; warnColor = '#86efac';
                    blobColor = 'radial-gradient(circle,#22c55e,transparent)';
                    warningIcon = iconCheck; warningMsg = 'You are on track to hit your goal!';
                    statusLabel = 'On Track';
                } else if (dailyAvg >= requiredPace * 0.7) {
                    // Moderate — YELLOW
                    statusColor = '#facc15';
                    badgeBg = 'rgba(234,179,8,0.2)'; badgeBorder = 'rgba(234,179,8,0.35)'; badgeText = '#facc15';
                    warnBg = 'rgba(234,179,8,0.1)'; warnBorder = 'rgba(234,179,8,0.25)'; warnColor = '#fde68a';
                    blobColor = 'radial-gradient(circle,#eab308,transparent)';
                    warningIcon = iconWarn; warningMsg = 'You are slightly behind — pick up the pace!';
                    statusLabel = 'Moderate';
                } else {
                    // Behind — RED
                    statusColor = '#f87171';
                    badgeBg = 'rgba(239,68,68,0.2)'; badgeBorder = 'rgba(239,68,68,0.35)'; badgeText = '#f87171';
                    warnBg = 'rgba(239,68,68,0.1)'; warnBorder = 'rgba(239,68,68,0.25)'; warnColor = '#fca5a5';
                    blobColor = 'radial-gradient(circle,#ef4444,transparent)';
                    warningIcon = iconAlert; warningMsg = 'You are falling behind! Increase daily practice now.';
                    statusLabel = 'Behind';
                }

                // ── Update DOM ──
                const daysNum = document.getElementById('gg-days-num');
                if (daysNum) {
                    daysNum.textContent = remaining <= 0 ? '0' : daysUntilTarget.toLocaleString();
                    daysNum.style.color = statusColor;
                }

                const finishEl = document.getElementById('gg-finish-date');
                if (finishEl) {
                    finishEl.textContent = remaining <= 0
                        ? '🎉 Goal complete!'
                        : (daysNeeded !== null
                            ? `At current pace, you will finish by ${finishDateStr}`
                            : 'Log practice to calculate finish date');
                }

                const badge = document.getElementById('gg-status-badge');
                if (badge) {
                    badge.textContent = statusLabel;
                    badge.style.background = badgeBg;
                    badge.style.color = badgeText;
                    badge.style.border = `1px solid ${badgeBorder}`;
                }

                const blob = document.getElementById('gg-blob');
                if (blob) blob.style.background = blobColor;

                const fill = document.getElementById('gg-progress-fill');
                if (fill) {
                    fill.style.width = donePct.toFixed(1) + '%';
                    if (remaining <= 0) {
                        fill.style.background = 'linear-gradient(90deg,#22c55e,#4ade80)';
                    } else if (dailyAvg >= requiredPace) {
                        fill.style.background = 'linear-gradient(90deg,#22c55e,#4ade80)';
                    } else if (dailyAvg >= requiredPace * 0.7) {
                        fill.style.background = 'linear-gradient(90deg,#ca8a04,#facc15)';
                    } else {
                        fill.style.background = 'linear-gradient(90deg,#dc2626,#f87171)';
                    }
                }

                const pctLabel = document.getElementById('gg-pct-label');
                if (pctLabel) pctLabel.textContent = `${donePct.toFixed(1)}% done`;

                const doneQsEl = document.getElementById('gg-done-qs');
                if (doneQsEl) doneQsEl.textContent = `${current.toLocaleString()} solved`;

                const remainingEl = document.getElementById('gg-remaining');
                if (remainingEl) remainingEl.textContent = remaining.toLocaleString();

                const avgEl = document.getElementById('gg-daily-avg');
                if (avgEl) avgEl.textContent = dailyAvg > 0 ? dailyAvg.toFixed(1) : '—';

                const gapEl = document.getElementById('gg-gap-pct');
                if (gapEl) gapEl.textContent = remaining > 0 ? `${gapPct}%` : '0%';

                // Gap text line
                const warn = document.getElementById('gg-warning');
                if (warn) {
                    warn.style.background = warnBg;
                    warn.style.border = `1px solid ${warnBorder}`;
                    warn.style.color = warnColor;
                }
                const warnIcon = document.getElementById('gg-warning-icon');
                if (warnIcon) warnIcon.innerHTML = warningIcon;
                const warnText = document.getElementById('gg-warning-text');
                if (warnText) {
                    warnText.textContent = warningMsg;
                }
            })();
            // ══ END GOAL GAP ══
        }

        // Handle Goal Gap Date Update
        window.updateGoalGapDate = function (val) {
            const db = AppStorage.get();
            db.goalGapDate = val;
            AppStorage.saveLocal();
            renderDashboard();
        }

        // Practice Line Chart
        window.renderPracticeChart = function () {
            const db = AppStorage.get();
            const isDark = document.documentElement.classList.contains('dark');
            const filter = document.getElementById('practice-filter').value;
            const emptyTrend = document.getElementById('empty-practice-trend');
            const canvas = document.getElementById('practiceLineChart');
            const logKeys = Object.keys(db.practiceLogs || {});

            if (logKeys.length === 0) {
                emptyTrend.style.display = 'block'; canvas.style.display = 'none';
                return;
            }
            emptyTrend.style.display = 'none'; canvas.style.display = 'block';

            let labels = [];
            let points = [];
            let today = new Date();
            today.setHours(0, 0, 0, 0);

            if (filter === '7' || filter === '30') {
                let days = parseInt(filter);
                for (let i = days - 1; i >= 0; i--) {
                    let d = new Date(today);
                    d.setDate(d.getDate() - i);
                    let dStr = getLocalDateStr(d);
                    let log = db.practiceLogs[dStr];
                    labels.push(d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }));
                    points.push(log ? (log.p + log.c + log.m) : 0);
                }
            } else {
                let startMonth = new Date(today);
                startMonth.setDate(1);
                let monthsToShow = 12;

                if (filter === 'all') {
                    if (logKeys.length > 0) {
                        let firstLogDate = new Date(logKeys.sort()[0]);
                        let diffMonths = (today.getFullYear() - firstLogDate.getFullYear()) * 12 + (today.getMonth() - firstLogDate.getMonth()) + 1;
                        monthsToShow = Math.max(2, diffMonths);
                    }
                }

                for (let i = monthsToShow - 1; i >= 0; i--) {
                    let d = new Date(today.getFullYear(), today.getMonth() - i, 1);
                    let monthStr = d.toLocaleDateString('en-US', { month: 'short', year: filter === 'all' ? '2-digit' : undefined });
                    labels.push(monthStr);

                    let sum = 0;
                    logKeys.forEach(k => {
                        let logD = new Date(k);
                        if (logD.getMonth() === d.getMonth() && logD.getFullYear() === d.getFullYear()) {
                            sum += (db.practiceLogs[k].p + db.practiceLogs[k].c + db.practiceLogs[k].m);
                        }
                    });
                    points.push(sum);
                }
            }
            renderChartJsLine('practiceLineChart', labels, points, 'Questions', isDark);
        };

        // Monthly Task Heatmap
        window.renderTaskHeatmap = function () {
            const db = AppStorage.get();
            const isDark = document.documentElement.classList.contains('dark');
            const sel = document.getElementById('heatmap-month-filter');
            const container = document.getElementById('task-heatmap-container');
            if (!sel || !container) return;

            // Build month options (last 12 months)
            const now = new Date();
            if (sel.options.length === 0) {
                for (let i = 0; i < 12; i++) {
                    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                    const opt = document.createElement('option');
                    opt.value = val; opt.textContent = label;
                    sel.appendChild(opt);
                }
            }

            const [yr, mo] = sel.value.split('-').map(Number);
            const daysInMonth = new Date(yr, mo, 0).getDate();
            const firstDay = new Date(yr, mo - 1, 1).getDay(); // 0=Sun

            // Count completed tasks per day — use completed_at (actual completion date)
            const countByDay = {};
            (db.tasks || []).filter(t => t.completed).forEach(t => {
                const src = t.completed_at || t.created_at;
                if (!src) return;
                const d = new Date(src);
                if (d.getFullYear() === yr && d.getMonth() + 1 === mo) {
                    const day = d.getDate();
                    countByDay[day] = (countByDay[day] || 0) + 1;
                }
            });

            const getColor = (count) => {
                if (!count || count === 0) return isDark ? '#1f2937' : '#f3f4f6';
                if (count === 1) return isDark ? '#6b21a8' : '#e9d5ff';
                if (count === 2) return isDark ? '#7e22ce' : '#c084fc';
                if (count === 3) return isDark ? '#9333ea' : '#a855f7';
                if (count === 4) return isDark ? '#a855f7' : '#7c3aed';
                return isDark ? '#d8b4fe' : '#5b21b6'; // 5+
            };

            const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
            let html = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;">`;

            // Day name headers
            dayNames.forEach(d => {
                html += `<div style="text-align:center;font-size:9px;font-weight:700;color:${isDark ? '#6b7280' : '#9ca3af'};padding-bottom:2px;">${d}</div>`;
            });

            // Empty cells before first day
            for (let i = 0; i < firstDay; i++) {
                html += `<div></div>`;
            }

            // Day cells
            for (let day = 1; day <= daysInMonth; day++) {
                const count = countByDay[day] || 0;
                const bg = getColor(count);
                const border = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
                const textCol = count > 0 ? (isDark ? '#fff' : '#fff') : (isDark ? '#4b5563' : '#9ca3af');
                const isToday = (new Date().getDate() === day && new Date().getMonth() + 1 === mo && new Date().getFullYear() === yr);
                html += `<div title="${day} — ${count} task${count !== 1 ? 's' : ''} done" style="
                    background:${bg};
                    border-radius:6px;
                    aspect-ratio:1;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    font-size:10px;
                    font-weight:700;
                    color:${textCol};
                    border:${isToday ? '2px solid #8b5cf6' : '1px solid ' + border};
                    cursor:default;
                    transition:transform 0.15s;
                " onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'">${day}</div>`;
            }

            html += `</div>`;
            container.innerHTML = html;
        };

        // Task Completion Line Chart
        window.renderTaskCompletionChart = function () {
            const db = AppStorage.get();
            const isDark = document.documentElement.classList.contains('dark');
            const filter = document.getElementById('task-chart-filter') ? document.getElementById('task-chart-filter').value : '7';
            const emptyEl = document.getElementById('empty-task-trend');
            const canvas = document.getElementById('taskCompletionChart');
            const completedTasks = (db.tasks || []).filter(t => t.completed);

            if (completedTasks.length === 0) {
                if (emptyEl) emptyEl.style.display = 'block';
                if (canvas) canvas.style.display = 'none';
                return;
            }
            if (emptyEl) emptyEl.style.display = 'none';
            if (canvas) canvas.style.display = 'block';

            let labels = [], points = [];
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Helper: get the relevant date for a completed task (completed_at if available, else created_at)
            const getTaskDate = (t) => {
                const src = t.completed_at || t.created_at;
                return src ? new Date(src) : null;
            };

            if (filter === '7' || filter === '30') {
                const days = parseInt(filter);
                for (let i = days - 1; i >= 0; i--) {
                    const d = new Date(today);
                    d.setDate(d.getDate() - i);
                    const dStr = getLocalDateStr(d);
                    const count = completedTasks.filter(t => {
                        const td = getTaskDate(t);
                        return td && getLocalDateStr(td) === dStr;
                    }).length;
                    labels.push(d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }));
                    points.push(count);
                }
            } else {
                // All time - group by month
                const taskDateObjs = completedTasks.map(t => getTaskDate(t)).filter(Boolean);
                if (taskDateObjs.length === 0) return;
                let firstDate = new Date(Math.min(...taskDateObjs.map(d => d.getTime())));
                let diffMonths = (today.getFullYear() - firstDate.getFullYear()) * 12 + (today.getMonth() - firstDate.getMonth()) + 1;
                let monthsToShow = Math.max(2, diffMonths);
                for (let i = monthsToShow - 1; i >= 0; i--) {
                    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
                    const monthStr = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
                    labels.push(monthStr);
                    const count = completedTasks.filter(t => {
                        const td = getTaskDate(t);
                        return td && td.getMonth() === d.getMonth() && td.getFullYear() === d.getFullYear();
                    }).length;
                    points.push(count);
                }
            }
            renderChartJsLine('taskCompletionChart', labels, points, 'Tasks Done', isDark, '#22c55e');
        };

        // Task Status / Tags Pie Chart
        window.renderTaskPieChart = function () {
            const db = AppStorage.get();
            const isDark = document.documentElement.classList.contains('dark');
            const mode = document.getElementById('task-pie-mode') ? document.getElementById('task-pie-mode').value : 'status';
            const emptyEl = document.getElementById('empty-task-pie');
            const canvas = document.getElementById('taskPieChart');
            const legendEl = document.getElementById('task-pie-legend');
            const tasks = db.tasks || [];

            if (tasks.length === 0) {
                if (emptyEl) emptyEl.style.display = 'block';
                if (canvas) canvas.style.display = 'none';
                if (legendEl) legendEl.innerHTML = '';
                return;
            }
            if (emptyEl) emptyEl.style.display = 'none';
            if (canvas) canvas.style.display = 'block';

            let labels = [], data = [], colors = [];

            if (mode === 'status') {
                const done = tasks.filter(t => t.completed).length;
                const pending = tasks.length - done;
                labels = ['Completed', 'Pending'];
                data = [done, pending];
                colors = isDark ? ['#e2e8f0', '#374151'] : ['#111111', '#e5e7eb'];
            } else {
                // By Tags
                const tagMap = {};
                let untagged = 0;
                tasks.forEach(t => {
                    const matches = (t.text || '').match(/(?:^|\s)#([\w-]+)/g);
                    if (matches && matches.length > 0) {
                        matches.forEach(m => {
                            const tag = m.trim().replace('#', '');
                            tagMap[tag] = (tagMap[tag] || 0) + 1;
                        });
                    } else {
                        untagged++;
                    }
                });
                const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#14b8a6', '#f97316', '#84cc16'];
                const entries = Object.entries(tagMap).sort((a, b) => b[1] - a[1]);
                entries.forEach(([tag, cnt], i) => {
                    labels.push('#' + tag);
                    data.push(cnt);
                    colors.push(palette[i % palette.length]);
                });
                if (untagged > 0) {
                    labels.push('No Tag');
                    data.push(untagged);
                    colors.push(isDark ? '#4b5563' : '#d1d5db');
                }
            }

            // Destroy old chart
            if (taskPieChartInst) { taskPieChartInst.destroy(); taskPieChartInst = null; }

            const ctx = canvas.getContext('2d');
            taskPieChartInst = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels,
                    datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: isDark ? '#111111' : '#ffffff', hoverOffset: 6 }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '62%',
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => ` ${ctx.label}: ${ctx.parsed} (${Math.round(ctx.parsed / ctx.dataset.data.reduce((a, b) => a + b, 0) * 100)}%)`
                            }
                        }
                    }
                }
            });

            // Build custom legend
            if (legendEl) {
                legendEl.innerHTML = labels.map((l, i) => `
                    <div class="flex items-center gap-1.5">
                        <div style="width:10px;height:10px;border-radius:3px;background:${colors[i]};flex-shrink:0;"></div>
                        <span style="font-size:10px;font-weight:700;color:${isDark ? '#9ca3af' : '#6b7280'}">${l} (${data[i]})</span>
                    </div>`).join('');
            }
        };

        // ── Productivity Analysis Radar Chart ──
        window.renderRadarChart = function () {
            const db = AppStorage.get();
            const isDark = document.documentElement.classList.contains('dark');
            const canvas = document.getElementById('radarChart');
            const legendEl = document.getElementById('radar-legend');
            if (!canvas) return;

            // Tasks Score
            const totalTasks = (db.tasks || []).length;
            const doneTasks = (db.tasks || []).filter(t => t.completed).length;
            const tasksScore = totalTasks > 0 ? Math.min(100, (doneTasks / totalTasks) * 100) : 0;

            // Questions Score (out of 10000)
            let tp = 0, tc = 0, tm = 0;
            Object.values(db.practiceLogs || {}).forEach(l => { tp += l.p || 0; tc += l.c || 0; tm += l.m || 0; });
            const questionsScore = Math.min(100, ((tp + tc + tm) / 10000) * 100);

            // Mock Score Average (normalized 0-100 using percentage)
            let mockScore = 0;
            if ((db.mocks || []).length > 0) {
                const scores = db.mocks.map(m => {
                    const max = parseInt(m.maxMarks) || 100;
                    const s = (parseInt(m.correct || 0) * 4) - parseInt(m.incorrect || 0);
                    return Math.max(0, Math.min(100, (s / max) * 100));
                });
                mockScore = scores.reduce((a, b) => a + b, 0) / scores.length;
            }

            // Revision Score
            const topics = db.topics || [];
            let totalRevs = 0, doneRevs = 0;
            topics.forEach(t => { const max = t.maxRevisions || 6; totalRevs += max; doneRevs += Math.min(t.reviewCount || 0, max); });
            const revisionScore = totalRevs > 0 ? Math.min(100, (doneRevs / totalRevs) * 100) : 0;

            // Consistency Score (active practice days / total days since first log)
            const logDates = Object.keys(db.practiceLogs || {}).sort();
            let consistencyScore = 0;
            if (logDates.length > 0) {
                const firstDate = new Date(logDates[0]);
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const totalDays = Math.max(1, Math.round((today - firstDate) / 86400000) + 1);
                const activeDays = logDates.length;
                consistencyScore = Math.min(100, (activeDays / totalDays) * 100);
            }

            const metrics = ['Tasks Done', 'Questions', 'Mock Score', 'Revisions', 'Consistency'];
            const values = [tasksScore, questionsScore, mockScore, revisionScore, consistencyScore].map(v => parseFloat(v.toFixed(1)));
            const gridCol = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
            const textCol = isDark ? '#9ca3af' : '#6b7280';
            const lineCol = isDark ? '#ec4899' : '#db2777'; // Pink
            const fillCol = isDark ? 'rgba(236,72,153,0.18)' : 'rgba(219,39,119,0.12)';

            if (radarChartInst) { radarChartInst.destroy(); radarChartInst = null; }
            const ctx = canvas.getContext('2d');
            radarChartInst = new Chart(ctx, {
                type: 'radar',
                data: {
                    labels: metrics,
                    datasets: [{
                        label: 'Score',
                        data: values,
                        backgroundColor: fillCol,
                        borderColor: lineCol,
                        borderWidth: 2,
                        pointBackgroundColor: lineCol,
                        pointRadius: 4,
                        pointHoverRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        r: {
                            min: 0, max: 100,
                            ticks: { stepSize: 25, color: textCol, font: { size: 9, weight: '700' }, backdropColor: 'transparent' },
                            grid: { color: gridCol },
                            angleLines: { color: gridCol },
                            pointLabels: { color: textCol, font: { size: 10, weight: '700' } }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.raw}%` }
                        }
                    }
                }
            });

            // Legend
            if (legendEl) {
                legendEl.innerHTML = metrics.map((m, i) => `
                    <div class="flex items-center gap-2 bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm px-3 py-1.5 rounded-full border border-gray-200/60 dark:border-gray-700/60 shadow-sm transition-transform hover:scale-105 cursor-default">
                        <div style="width:10px;height:10px;border-radius:50%;background:${lineCol};opacity:${0.4 + i * 0.12};box-shadow:0 0 8px ${lineCol}80;flex-shrink:0;"></div>
                        <span style="font-size:9px;font-weight:800;letter-spacing:0.05em;color:${textCol};text-transform:uppercase;">${m}: ${values[i]}%</span>
                    </div>`).join('');
            }
        };

        // ── Smoothed Progress Trend (7-Day Rolling Average) ──
        window.renderRollingAvgChart = function () {
            const db = AppStorage.get();
            const isDark = document.documentElement.classList.contains('dark');
            const filter = document.getElementById('rolling-avg-filter') ? document.getElementById('rolling-avg-filter').value : '30';
            const emptyEl = document.getElementById('empty-rolling');
            const canvas = document.getElementById('rollingAvgChart');
            if (!canvas) return;

            const today = new Date(); today.setHours(0, 0, 0, 0);
            let days = filter === '7' ? 7 : filter === '30' ? 30 : 90;

            // Determine date range
            if (filter === 'all') {
                const logDates = Object.keys(db.practiceLogs || {}).sort();
                const taskDates = (db.tasks || []).map(t => t.created_at ? getLocalDateStr(new Date(t.created_at)) : null).filter(Boolean).sort();
                const allDates = [...logDates, ...taskDates].sort();
                if (allDates.length > 0) {
                    const first = new Date(allDates[0]); first.setHours(0, 0, 0, 0);
                    days = Math.max(14, Math.round((today - first) / 86400000) + 1);
                } else { days = 30; }
            }

            // Build daily raw scores
            const rawScores = [];
            for (let i = days - 1; i >= 0; i--) {
                const d = new Date(today); d.setDate(d.getDate() - i);
                const dStr = getLocalDateStr(d);
                const log = db.practiceLogs[dStr];
                const qs = log ? (log.p + log.c + log.m) : 0;
                // Use completed_at for the date a task was actually completed
                const completedTasks = (db.tasks || []).filter(t => {
                    if (!t.completed) return false;
                    const src = t.completed_at || t.created_at;
                    return src && getLocalDateStr(new Date(src)) === dStr;
                }).length;
                // Normalize: qs/30 (30 qs = full day) + tasks*10 (10 tasks = full contribution), cap 100
                const score = Math.min(100, (qs / 30) * 60 + completedTasks * 10);
                rawScores.push({ date: d, score });
            }

            if (rawScores.every(r => r.score === 0)) {
                if (emptyEl) emptyEl.style.display = 'block';
                canvas.style.display = 'none'; return;
            }
            if (emptyEl) emptyEl.style.display = 'none';
            canvas.style.display = 'block';

            // 7-day rolling average
            const labels = [], rollingData = [];
            for (let i = 0; i < rawScores.length; i++) {
                const windowStart = Math.max(0, i - 6);
                const window = rawScores.slice(windowStart, i + 1);
                const avg = window.reduce((s, r) => s + r.score, 0) / 7; // always divide by 7
                labels.push(rawScores[i].date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }));
                rollingData.push(parseFloat(avg.toFixed(1)));
            }

            if (rollingChartInst) { rollingChartInst.destroy(); rollingChartInst = null; }
            const ctx = canvas.getContext('2d');
            const lineCol = isDark ? '#34d399' : '#059669';
            const fillCol = isDark ? 'rgba(52,211,153,0.12)' : 'rgba(5,150,105,0.08)';
            const gridCol = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
            const textCol = isDark ? '#9ca3af' : '#6b7280';

            rollingChartInst = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        label: '7-Day Avg Score',
                        data: rollingData,
                        borderColor: lineCol,
                        backgroundColor: fillCol,
                        fill: true,
                        tension: 0.45,
                        borderWidth: 2.5,
                        pointRadius: rawScores.length <= 14 ? 4 : 2,
                        pointBackgroundColor: lineCol,
                        pointHoverRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { grid: { color: gridCol }, ticks: { color: textCol, font: { size: 9 }, maxTicksLimit: 8, maxRotation: 0 } },
                        y: { min: 0, max: 100, grid: { color: gridCol }, ticks: { color: textCol, font: { size: 9 }, callback: v => v + '%' } }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: { callbacks: { label: ctx => ` Score: ${ctx.raw}%` } }
                    }
                }
            });
        };

        // ── Preparation Health Score ──
        window.renderHealthScore = function () {
            const db = AppStorage.get();

            // 1. Task Discipline
            const totalTasks = (db.tasks || []).length;
            const completedTasks = (db.tasks || []).filter(t => t.completed).length;
            const task_score = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

            // 2. Practice Strength
            let tp = 0, tc = 0, tm = 0;
            const logDates = Object.keys(db.practiceLogs || {}).sort();
            logDates.forEach(date => {
                const l = db.practiceLogs[date];
                tp += l.p || 0; tc += l.c || 0; tm += l.m || 0;
            });
            const totalQuestions = tp + tc + tm;
            const practice_score = Math.min(100, (totalQuestions / 9000) * 100);

            // 3. Mock Performance
            let mock_score = 0;
            if ((db.mocks || []).length > 0) {
                const scores = db.mocks.map(m => {
                    const max = parseInt(m.maxMarks) || 100;
                    const s = (parseInt(m.correct || 0) * 4) - Math.max(0, parseInt(m.incorrect || 0));
                    return Math.max(0, Math.min(100, (s / max) * 100));
                });
                mock_score = scores.reduce((a, b) => a + b, 0) / scores.length;
            }

            // 4. Revision Consistency
            const topics = db.topics || [];
            let revision_score = 0;
            if (topics.length > 0) {
                const completedRevs = topics.filter(t => (t.reviewCount || 0) >= (t.maxRevisions || 6)).length;
                revision_score = (completedRevs / topics.length) * 100;
            }

            // Streak
            let streak = 0;
            if (logDates.length > 0) {
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const sortedDates = logDates.map(d => new Date(d)).sort((a, b) => b - a);
                if (today - sortedDates[0] <= 86400000) {
                    streak = 1;
                    for (let i = 1; i < sortedDates.length; i++) {
                        if (sortedDates[i - 1] - sortedDates[i] === 86400000) streak++;
                        else break;
                    }
                }
            }

            // Total Revs
            let totalRevsCount = 0;
            topics.forEach(t => totalRevsCount += (t.reviewCount || 0));

            // Final Score
            const rawScore = (task_score * 0.2) + (practice_score * 0.3) + (mock_score * 0.3) + (revision_score * 0.2);
            const finalScore = Math.min(100, Math.max(0, Math.round(rawScore)));

            // DOM Updates
            const circle = document.getElementById('health-score-circle');
            if (circle) circle.setAttribute('stroke-dasharray', `${finalScore}, 100`);

            const valEl = document.getElementById('health-score-val');
            if (valEl) {
                valEl.innerText = finalScore;
                circle.classList.remove('text-blue-500', 'text-green-500', 'text-yellow-500', 'text-red-500');
                if (finalScore >= 80) circle.classList.add('text-green-500');
                else if (finalScore >= 50) circle.classList.add('text-yellow-500');
                else circle.classList.add('text-red-500');
            }

            const el = id => document.getElementById(id);
            if (el('health-task-pct')) el('health-task-pct').innerText = `${Math.round(task_score)}%`;
            if (el('health-prac-pct')) el('health-prac-pct').innerText = `${Math.round(practice_score)}%`;
            if (el('health-mock-pct')) el('health-mock-pct').innerText = `${Math.round(mock_score)}%`;
            if (el('health-rev-pct')) el('health-rev-pct').innerText = `${Math.round(revision_score)}%`;

            if (el('health-streak')) el('health-streak').innerHTML = `${streak} ${streak === 1 ? 'day' : 'days'} ${streak > 2 ? '<svg class="w-3.5 h-3.5 ml-0.5 text-orange-500 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z"></path></svg>' : ''}`;
            if (el('health-total-qs')) el('health-total-qs').innerText = totalQuestions.toLocaleString();
            if (el('health-avg-mock')) el('health-avg-mock').innerText = `${Math.round(mock_score)}%`;
            if (el('health-total-revs')) el('health-total-revs').innerText = totalRevsCount;

            // Insights Logic
            const scoresMap = {
                'Task discipline': task_score,
                'Practice strength': practice_score,
                'Mock tests': mock_score,
                'Revision': revision_score
            };

            let minKey = Object.keys(scoresMap)[0], maxKey = Object.keys(scoresMap)[0];
            Object.keys(scoresMap).forEach(k => {
                if (scoresMap[k] < scoresMap[minKey]) minKey = k;
                if (scoresMap[k] > scoresMap[maxKey]) maxKey = k;
            });

            const insightsHtml = [];
            if (scoresMap[maxKey] > 0) {
                insightsHtml.push(`<div class="text-[11px] font-semibold text-green-500 dark:text-green-400 flex items-center gap-1.5"><svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>${maxKey} is strong</div>`);
            }
            if (scoresMap[minKey] < 50 && (totalTasks + totalQuestions + topics.length) > 0) {
                insightsHtml.push(`<div class="text-[11px] font-semibold text-red-500 dark:text-red-400 flex items-center gap-1.5"><svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>${minKey} needs focus</div>`);
            }
            if (insightsHtml.length === 0) insightsHtml.push(`<div class="text-[11px] font-semibold text-gray-500">Log more data for insights</div>`);

            const insightsEl = el('health-score-insights');
            if (insightsEl) insightsEl.innerHTML = insightsHtml.slice(0, 2).join('');
        };

        function renderMocks() {
            const db = AppStorage.get();
            const historyContainer = document.getElementById('mock-history');
            historyContainer.innerHTML = '';

            if (db.mocks.length === 0) {
                historyContainer.innerHTML = `<div class="text-center text-gray-400 text-sm py-4 animate-pulse">No mock tests added yet.</div>`;
                return;
            }

            const sortedMocks = [...db.mocks].sort((a, b) => new Date(b.date) - new Date(a.date));
            sortedMocks.forEach((m, index) => {
                const maxMarks = parseInt(m.maxMarks) || 100;
                const score = (parseInt(m.correct) * 4) - parseInt(m.incorrect);
                const percentage = maxMarks > 0 ? Math.round((Math.max(0, score) / maxMarks) * 100) : 0;
                const displayDate = formatDatePretty(m.date);

                let timePillText = '';
                if (m.timeTaken) {
                    const h = Math.floor(m.timeTaken / 60);
                    const mins = m.timeTaken % 60;
                    if (h > 0 && mins > 0) timePillText = `${h}h ${mins}m`;
                    else if (h > 0) timePillText = `${h}h`;
                    else timePillText = `${mins}m`;
                }

                const timePill = timePillText ? `
                <div class="text-[10px] text-gray-500 bg-gray-100 dark:bg-gray-800 dark:text-gray-400 px-1.5 py-0.5 rounded font-medium flex items-center gap-1 border border-gray-200 dark:border-gray-700">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    ${timePillText}
                </div>` : '';

                historyContainer.innerHTML += `
                <div class="bg-white dark:bg-gray-800/80 rounded-2xl p-4 flex flex-col gap-4 shadow-sm border border-gray-100 dark:border-gray-700/60 transition-all hover:-translate-y-1 hover:shadow-md opacity-0 animate-list-item-in relative overflow-hidden group" style="animation-delay: ${index * 60}ms">
                    <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/5 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]"></div>
                    
                    <div class="flex justify-between items-start relative z-10 border-b border-gray-100 dark:border-gray-700/50 pb-3">
                        <div class="flex-1 pr-2">
                            <div class="font-bold text-black dark:text-white text-[15px] mb-1 leading-tight tracking-tight">${m.name}</div>
                            <div class="flex items-center gap-2">
                                <div class="text-[10px] text-gray-400 font-bold uppercase tracking-widest flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg> ${displayDate}</div>
                                ${timePill}
                            </div>
                        </div>
                        <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onclick="openEditMock('${m.id}')" class="w-8 h-8 flex items-center justify-center bg-gray-50 dark:bg-gray-700 rounded-full text-gray-500 dark:text-gray-300 hover:bg-gray-200 dark:bg-gray-600 transition-colors active:scale-95 border border-gray-200 dark:border-gray-600">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                            </button>
                            <button onclick="openDeleteConfirm('mock', '${m.id}', 'Delete Mock Test?', 'Are you sure you want to delete this mock test?')" class="w-8 h-8 flex items-center justify-center bg-red-50 dark:bg-red-900/30 rounded-full text-red-500 hover:bg-red-100 dark:hover:bg-red-800/50 transition-colors active:scale-95 border border-red-100 dark:border-red-900/50">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </button>
                        </div>
                    </div>

                    <div class="flex justify-between items-center relative z-10">
                        <div>
                            <div class="text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-0.5">Score</div>
                            <div class="font-black text-lg text-black dark:text-white">${score} <span class="text-xs font-semibold text-gray-400">/ ${maxMarks}</span></div>
                        </div>
                        <div class="flex items-center gap-3">
                            <div class="text-right">
                                <div class="text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-0.5">Accuracy</div>
                                <div class="font-bold text-sm ${percentage >= 80 ? 'text-green-500' : percentage >= 50 ? 'text-orange-500' : 'text-red-500'}">${percentage}%</div>
                            </div>
                            <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 shadow-inner relative overflow-hidden bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600">
                                <div class="water-wave bg-blue-500/50 dark:bg-blue-500/50" style="top: ${100 - percentage}%;"></div>
                                <div class="water-wave bg-blue-600/50 dark:bg-blue-600/50" style="top: ${100 - percentage}%; animation-duration: 7s;"></div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            });
        }

        function renderRevision() {
            const db = AppStorage.get();
            const list = document.getElementById('revision-list');
            const completedList = document.getElementById('completed-revision-list');
            const completedContainer = document.getElementById('completed-revision-container');

            list.innerHTML = '';
            completedList.innerHTML = '';
            let dueCount = 0;
            let completedCount = 0;

            (db.topics || []).forEach((t, index) => {
                const maxRev = t.maxRevisions || 10;
                const nextDue = getNextDueDate(t.lastReviewed, t.reviewCount);
                const isDue = nextDue && isDueToday(nextDue);
                if (isDue && t.reviewCount < maxRev) dueCount++;

                const perc = Math.min(100, Math.round((t.reviewCount / maxRev) * 100));
                const dateStrDisplay = nextDue ? formatDatePretty(nextDue.toISOString()) : "Done";
                const firstDateDisplay = t.firstDate ? formatDatePretty(t.firstDate) : formatDatePretty(t.lastReviewed);

                const topicHtml = `
                <div class="bg-white dark:bg-gray-800/80 rounded-2xl p-5 mb-4 shadow-sm border border-gray-100 dark:border-gray-700/60 transition-all hover:-translate-y-1 hover:shadow-md opacity-0 animate-list-item-in relative overflow-hidden group ${isDue ? 'border-l-[5px] border-l-red-500' : ''}" style="animation-delay: ${index * 60}ms">
                    <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/5 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]"></div>
                    
                    <div class="flex justify-between items-start mb-3 relative z-10">
                        <h4 class="font-extrabold text-black dark:text-white text-[15px] pr-2 tracking-tight leading-snug">${t.name}</h4>
                        <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onclick="openEditTopic('${t.id}')" class="w-8 h-8 flex items-center justify-center bg-gray-50 dark:bg-gray-700 rounded-full text-gray-500 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors active:scale-95 border border-gray-200 dark:border-gray-600">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                            </button>
                            <button onclick="openDeleteConfirm('topic', '${t.id}', 'Delete Topic?', 'Are you sure you want to remove this topic from tracking?')" class="w-8 h-8 flex items-center justify-center bg-red-50 dark:bg-red-900/30 rounded-full text-red-500 hover:bg-red-100 dark:hover:bg-red-800/50 transition-colors active:scale-95 border border-red-100 dark:border-red-900/50">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </button>
                        </div>
                    </div>
                    
                    <div class="relative z-10 mb-4">
                        <div class="flex justify-between items-center mb-1.5">
                            <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Progress</span>
                            <span class="text-[10px] font-black text-blue-500 dark:text-blue-400">${perc}%</span>
                        </div>
                        <div class="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                            <div class="bg-blue-500 dark:bg-blue-400 h-2 rounded-full transition-all duration-700 ease-out relative" style="width: ${perc}%">
                                <div class="absolute inset-0 bg-white/20 w-full animate-[shimmer_2s_infinite]"></div>
                            </div>
                        </div>
                    </div>

                    <div class="flex justify-between items-center bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 mb-2 relative z-10 border border-gray-100 dark:border-gray-700/50">
                        <div class="flex flex-col">
                            <span class="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">First Studied</span>
                            <span class="text-[11px] font-bold text-black dark:text-gray-300 flex items-center gap-1"><svg class="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg> ${firstDateDisplay}</span>
                        </div>
                        <div class="flex flex-col items-end text-right">
                            <span class="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Revision</span>
                            <span class="text-[11px] font-bold text-black dark:text-gray-300 flex items-center gap-1">${t.reviewCount} <span class="text-gray-400">/ ${maxRev}</span> <svg class="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg></span>
                        </div>
                    </div>

                    <div class="text-center relative z-10 mb-4">
                        <span class="text-[11px] font-bold ${isDue ? 'text-red-500 bg-red-50 dark:bg-red-500/10 dark:text-red-400 border border-red-100 dark:border-red-500/20' : 'text-gray-500 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700/50'} px-3 py-1.5 rounded-full inline-flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            Next Due: ${dateStrDisplay}
                        </span>
                    </div>

                    ${t.reviewCount < maxRev ? `
                    <div class="relative z-10">
                        <button onclick="markRevisionDone('${t.id}')" class="w-full bg-black dark:bg-white text-white dark:text-black py-3 rounded-xl text-xs font-bold transition-all hover:bg-gray-800 dark:hover:bg-gray-200 active:scale-95 shadow-md flex items-center justify-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>
                            Mark Next Revision Completed
                        </button>
                    </div>` : `
                    <div class="relative z-10 text-center mt-2">
                        <span class="inline-flex items-center gap-1.5 text-xs font-extrabold text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-4 py-2 rounded-xl border border-green-100 dark:border-green-800/50">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            All Revisions Completed!
                        </span>
                    </div>
                    `}
                </div>
            `;

                if (t.reviewCount >= maxRev) {
                    completedList.innerHTML += topicHtml;
                    completedCount++;
                } else {
                    list.innerHTML += topicHtml;
                }
            });

            if (db.topics.length === 0) {
                list.innerHTML = `<div class="text-center p-6 glass-card rounded-xl text-gray-500 dark:text-gray-400 text-sm animate-pulse">No topics tracked yet. Add one above!</div>`;
            } else if (list.innerHTML === '') {
                list.innerHTML = `<div class="text-center p-6 glass-card rounded-xl text-gray-500 dark:text-gray-400 text-sm">All topics revised up to date! 🎉</div>`;
            }

            if (completedCount > 0) {
                completedContainer.classList.remove('hidden');
            } else {
                completedContainer.classList.add('hidden');
            }

            const badge = document.getElementById('rev-count-badge');
            const navDot = document.getElementById('nav-rev-dot');
            if (dueCount === 0) {
                badge.style.display = 'none'; navDot.classList.add('hidden');
            } else {
                badge.style.display = 'inline-block'; badge.innerText = dueCount; navDot.classList.remove('hidden');
            }
        }

        let currentTaskFilter = 'All';
        let currentBottomTaskFilter = 'Completed';

        let isTaskSelectMode = false;
        let selectedTasks = [];

        window.toggleSelectMode = function () {
            isTaskSelectMode = !isTaskSelectMode;
            selectedTasks = [];
            renderTasks();
        };

        window.toggleTaskSelection = function (id) {
            if (selectedTasks.includes(id)) {
                selectedTasks = selectedTasks.filter(t => t !== id);
            } else {
                selectedTasks.push(id);
            }
            renderTasks();
        };

        window.deleteSelectedTasks = async function () {
            if (selectedTasks.length === 0) return;
            if (!confirm(`Are you sure you want to delete ${selectedTasks.length} tasks?`)) return;

            const db = AppStorage.get();
            db.tasks = db.tasks.filter(t => !selectedTasks.includes(t.id));
            AppStorage.saveLocal();

            if (currentUser) {
                for (const id of selectedTasks) {
                    supabaseClient.from('tasks').delete().eq('id', id).then();
                }
            }

            isTaskSelectMode = false;
            selectedTasks = [];
            updateLogic();
            showToast('Tasks deleted successfully');
        };

        window.setTaskFilter = function (filter) {
            currentTaskFilter = filter;
            document.querySelectorAll('.task-filter-btn').forEach(btn => {
                if (btn.getAttribute('data-filter') === filter) {
                    btn.className = `task-filter-btn px-4 py-2 rounded-xl text-[11px] font-bold tracking-wide whitespace-nowrap transition-colors bg-black text-white dark:bg-white dark:text-black shadow-md`;
                } else {
                    btn.className = `task-filter-btn px-4 py-2 rounded-xl text-[11px] font-bold tracking-wide whitespace-nowrap transition-colors bg-white/60 text-gray-500 border border-gray-200 hover:bg-white dark:bg-[#111111] dark:text-gray-400 dark:border-gray-700/50 dark:hover:bg-gray-800/80 shadow-sm`;
                }
            });
            renderTasks();
        };

        window.setBottomTaskFilter = function (filter) {
            currentBottomTaskFilter = filter;
            document.querySelectorAll('.bottom-task-filter-btn').forEach(btn => {
                if (btn.getAttribute('data-filter') === filter) {
                    btn.className = `bottom-task-filter-btn flex-1 py-2.5 rounded-xl text-[11px] font-bold tracking-wide transition-all bg-black dark:bg-white text-white dark:text-black shadow-md`;
                } else {
                    btn.className = `bottom-task-filter-btn flex-1 py-2.5 rounded-xl text-[11px] font-bold tracking-wide transition-all bg-white/60 text-gray-500 border border-gray-200 dark:bg-[#111111] dark:text-gray-400 dark:border-gray-700/50`;
                }
            });
            renderTasks();
        };

        function buildTaskItemHtml(t, index) {
            const dateStr = t.created_at ? formatDatePretty(t.created_at) : 'Just now';
            let rawText = t.text || "";
            let tags = [];
            let cleanText = rawText.replace(/(?:^|\s)#([\w-]+)/g, (match, tag) => { tags.push(tag); return ''; }).trim();
            if (!cleanText) cleanText = rawText;
            let tagsHtml = tags.map(tag => `<span class="px-1.5 py-[2px] bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 rounded flex items-center text-[9px] font-bold tracking-wider uppercase border border-blue-200 dark:border-blue-800">#${tag}</span>`).join('');

            return `
                <div draggable="${!t.completed && !isTaskSelectMode}" data-id="${t.id}" class="task-item p-4 flex items-center gap-3 transition-all opacity-0 animate-list-item-in border-b border-gray-200 dark:border-gray-700/50 last:border-b-0 ${!t.completed && !isTaskSelectMode ? 'hover:bg-white/50 dark:hover:bg-gray-800/30 cursor-grab active:cursor-grabbing' : ''}" style="animation-delay: ${index * 40}ms">
                    
                    ${isTaskSelectMode ? `
                    <button onclick="toggleTaskSelection('${t.id}')" class="w-6 h-6 rounded-md border-[1.5px] flex items-center justify-center shrink-0 transition-colors ${selectedTasks.includes(t.id) ? 'bg-red-500 border-red-500 text-white' : 'border-gray-400 dark:border-gray-500'}">
                        ${selectedTasks.includes(t.id) ? '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' : ''}
                    </button>
                    ` : `
                    ${!t.completed ? `
                    <div class="text-gray-300 dark:text-gray-600 shrink-0 hover:text-gray-500 transition-colors pointer-events-none hidden md:block">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"></path></svg>
                    </div>` : ''}
                    <button onclick="toggleTask('${t.id}')" class="w-6 h-6 rounded-md border-[1.5px] flex items-center justify-center shrink-0 transition-colors ${t.completed ? 'bg-black dark:bg-white border-black dark:border-white text-white dark:text-black' : 'border-gray-400 dark:border-gray-500 hover:border-gray-600'}">
                        ${t.completed ? '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' : ''}
                    </button>
                    `}
                    
                    <div class="flex-1 flex flex-col justify-center gap-1 w-full overflow-hidden ${isTaskSelectMode ? 'cursor-pointer' : 'pointer-events-none'}" ${isTaskSelectMode ? `onclick="toggleTaskSelection('${t.id}')"` : ''}>
                        <span class="text-[15px] font-bold transition-colors leading-tight break-words ${t.completed ? 'text-gray-400' : 'text-black dark:text-white'}">${cleanText}</span>
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-[10px] font-semibold text-gray-400 dark:text-gray-500 shrink-0">${dateStr}</span>
                            ${tagsHtml}
                        </div>
                    </div>
                    ${!isTaskSelectMode ? `
                    <button onclick="openTaskOptions('${t.id}', decodeURIComponent('${encodeURIComponent(t.text)}'), '${t.created_at || ''}', ${t.completed})" class="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-black dark:hover:text-white transition-colors active:scale-95 shrink-0 ml-1 z-10">
                        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <circle cx="12" cy="5.5" r="1.75"></circle>
                            <circle cx="12" cy="12" r="1.75"></circle>
                            <circle cx="12" cy="18.5" r="1.75"></circle>
                        </svg>
                    </button>
                    ` : ''}
                </div>`;
        }

        function applyDateFilter(tasks) {
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
            const currentMonth = today.getMonth(), currentYear = today.getFullYear();
            const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay();
            const startOfWeek = new Date(today); startOfWeek.setDate(today.getDate() - dayOfWeek + 1);
            const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(startOfWeek.getDate() + 6); endOfWeek.setHours(23, 59, 59, 999);
            if (currentTaskFilter === 'All') return tasks;
            return tasks.filter(t => {
                const d = new Date(t.created_at || 0); d.setHours(0, 0, 0, 0);
                if (currentTaskFilter === 'Today') return d.getTime() === today.getTime();
                if (currentTaskFilter === 'Tomorrow') return d.getTime() === tomorrow.getTime();
                if (currentTaskFilter === 'This Week') return d >= startOfWeek && d <= endOfWeek;
                if (currentTaskFilter === 'This Month') return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
                return true;
            });
        }

        function renderTasks() {
            const db = AppStorage.get();
            const list = document.getElementById('tasks-list');
            if (!list) return;

            const allTasks = applyDateFilter(db.tasks || []);
            const pendingTasks = allTasks.filter(t => !t.completed).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
            const completedTasks = allTasks.filter(t => t.completed).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
            const undoneTasks = pendingTasks; // Undone = not completed

            let html = '';

            // ── SECTION 1: Tasks To Be Completed (pending) ──
            if (pendingTasks.length === 0) {
                const emptyMsg = currentTaskFilter === 'All'
                    ? 'No pending tasks. Add one above!'
                    : `No pending tasks for ${currentTaskFilter}.`;
                html += `
                    <div class="glass-card rounded-[2rem] p-10 text-center flex flex-col items-center justify-center transition-transform hover:scale-[1.01] mb-4">
                        <div class="w-16 h-16 bg-gradient-to-tr from-blue-100 to-indigo-50 dark:from-blue-900/30 dark:to-indigo-900/20 rounded-full flex items-center justify-center mb-4 shadow-inner border border-white dark:border-white/5">
                            <svg class="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path></svg>
                        </div>
                        <h3 class="font-black text-black dark:text-white mb-1 text-lg tracking-tight">All Clear! 🎉</h3>
                        <p class="text-[12px] font-medium text-gray-500 dark:text-gray-400 max-w-[200px] mx-auto leading-relaxed">${emptyMsg}</p>
                    </div>`;
            } else {
                html += `<div class="flex items-center justify-between gap-2 mb-2 px-1">
                    <div class="flex items-center gap-2">
                        <span class="text-[11px] font-black uppercase tracking-widest text-gray-500 dark:text-gray-400">To Do</span>
                        <span class="text-[10px] font-bold bg-black dark:bg-white text-white dark:text-black px-2 py-0.5 rounded-full">${pendingTasks.length}</span>
                    </div>
                    <div class="flex items-center gap-2">
                        ${isTaskSelectMode && selectedTasks.length > 0 ? `
                        <button onclick="deleteSelectedTasks()" class="px-2.5 py-1 rounded-md text-[10px] font-bold bg-red-500 text-white hover:bg-red-600 transition-colors shadow-sm flex items-center gap-1">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            Delete (${selectedTasks.length})
                        </button>` : ''}
                        <button onclick="toggleSelectMode()" class="px-2.5 py-1 rounded-md text-[10px] font-bold transition-colors ${isTaskSelectMode ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}">
                            ${isTaskSelectMode ? 'Done' : 'Select'}
                        </button>
                    </div>
                </div>`;
                html += '<div id="pending-tasks-container" class="glass-card rounded-2xl overflow-hidden flex flex-col shadow-sm mb-5">';
                pendingTasks.forEach((t, i) => { html += buildTaskItemHtml(t, i); });
                html += '</div>';
            }

            // ── SECTION 2: Sub-filter tabs (Completed / Undone) ──
            const completedActive = currentBottomTaskFilter === 'Completed';
            const completedBtnClass = completedActive
                ? 'bottom-task-filter-btn flex-1 py-2.5 rounded-xl text-[11px] font-bold tracking-wide transition-all bg-black dark:bg-white text-white dark:text-black shadow-md'
                : 'bottom-task-filter-btn flex-1 py-2.5 rounded-xl text-[11px] font-bold tracking-wide transition-all bg-white/60 text-gray-500 border border-gray-200 dark:bg-[#111111] dark:text-gray-400 dark:border-gray-700/50';
            const undoneBtnClass = !completedActive
                ? 'bottom-task-filter-btn flex-1 py-2.5 rounded-xl text-[11px] font-bold tracking-wide transition-all bg-black dark:bg-white text-white dark:text-black shadow-md'
                : 'bottom-task-filter-btn flex-1 py-2.5 rounded-xl text-[11px] font-bold tracking-wide transition-all bg-white/60 text-gray-500 border border-gray-200 dark:bg-[#111111] dark:text-gray-400 dark:border-gray-700/50';

            const bottomList = completedActive ? completedTasks : undoneTasks;
            const bottomLabel = completedActive ? 'Completed' : 'Undone';
            const completedBadge = completedTasks.length;
            const undoneBadge = undoneTasks.length;

            html += `
            <div class="mb-3">
                <div class="flex gap-2 mb-4">
                    <button data-filter="Completed" onclick="setBottomTaskFilter('Completed')" class="${completedBtnClass}">
                        ✓ Completed (${completedBadge})
                    </button>
                    <button data-filter="Undone" onclick="setBottomTaskFilter('Undone')" class="${undoneBtnClass}">
                        ✗ Undone (${undoneBadge})
                    </button>
                </div>`;

            if (bottomList.length === 0) {
                const emptyBottomMsg = completedActive
                    ? 'No completed tasks yet. Mark some done!'
                    : 'No undone tasks — everything is in progress!';
                html += `
                    <div class="glass-card rounded-2xl p-6 text-center">
                        <p class="text-[13px] font-semibold text-gray-400 dark:text-gray-500">${emptyBottomMsg}</p>
                    </div>`;
            } else {
                html += '<div class="glass-card rounded-2xl overflow-hidden flex flex-col shadow-sm">';
                bottomList.forEach((t, i) => { html += buildTaskItemHtml(t, i); });
                html += '</div>';
            }

            html += '</div>';

            list.innerHTML = html;
            initDragAndDrop();
        }

        let draggedTaskItem = null;

        function initDragAndDrop() {
            const container = document.getElementById('pending-tasks-container');
            if (!container) return;

            // Items are already fresh DOM nodes from list.innerHTML — no cloneNode needed.
            // Attaching drag listeners directly prevents the double-toggle bug.
            const items = container.querySelectorAll('.task-item[draggable="true"]');
            items.forEach(item => {
                item.addEventListener('dragstart', function (e) {
                    if (e.target.closest('button')) {
                        e.preventDefault();
                        return;
                    }
                    draggedTaskItem = this;
                    e.dataTransfer.effectAllowed = 'move';
                    const img = new Image();
                    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                    if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(img, 0, 0);
                    setTimeout(() => {
                        this.classList.add('shadow-xl', 'scale-[1.01]', 'z-50', 'border', 'border-blue-500');
                        this.style.opacity = '1';
                    }, 0);
                });

                item.addEventListener('dragend', function () {
                    if (!draggedTaskItem) return;
                    draggedTaskItem = null;
                    this.classList.remove('shadow-xl', 'scale-[1.01]', 'z-50', 'border', 'border-blue-500');
                    this.style.opacity = '';
                    saveTaskOrder();
                });

                item.addEventListener('dragover', function (e) {
                    e.preventDefault();
                    if (!draggedTaskItem || this === draggedTaskItem) return;
                    const rect = this.getBoundingClientRect();
                    const mid = rect.top + rect.height / 2;
                    if (e.clientY < mid) {
                        this.parentNode.insertBefore(draggedTaskItem, this);
                    } else {
                        this.parentNode.insertBefore(draggedTaskItem, this.nextSibling);
                    }
                });
            });
        }

        async function saveTaskOrder() {
            const container = document.getElementById('pending-tasks-container');
            if (!container) return;

            const taskElements = container.querySelectorAll('.task-item[draggable="true"]');
            if (taskElements.length === 0) return;

            const db = AppStorage.get();
            const idsInOrder = Array.from(taskElements).map(el => el.getAttribute('data-id'));

            const tasksInOrder = idsInOrder.map(id => db.tasks.find(t => t.id === id)).filter(Boolean);
            if (tasksInOrder.length === 0) return;

            const sortedTimestamps = tasksInOrder
                .map(t => new Date(t.created_at || 0).getTime())
                .sort((a, b) => b - a);

            let updates = [];
            tasksInOrder.forEach((t, i) => {
                const newTime = new Date(sortedTimestamps[i]);
                t.created_at = newTime.toISOString();
                updates.push(t);
            });

            AppStorage.saveLocal();

            if (currentUser && updates.length > 0) {
                for (let t of updates) {
                    supabaseClient.from('tasks').update({ created_at: t.created_at }).eq('id', t.id).then();
                }
            }
        }

        // Modal Triggers
        document.querySelectorAll('.close-modal').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                document.getElementById(btn.getAttribute('data-target')).classList.add('hidden');
            });
        });

        document.getElementById('btn-open-rev-modal').addEventListener('click', () => {
            document.getElementById('form-revision').reset();
            document.getElementById('rev-date').value = getLocalDateStr(new Date());
            document.getElementById('rev-modal').classList.remove('hidden');
        });

        document.getElementById('btn-open-mock-modal').addEventListener('click', () => {
            document.getElementById('form-mock').reset();
            document.getElementById('mock-edit-id').value = "";
            document.getElementById('mock-date').value = getLocalDateStr(new Date());
            document.getElementById('mock-modal-title').innerText = "Add Mock Test";
            document.getElementById('mock-modal').classList.remove('hidden');
        });

        document.getElementById('btn-open-clear-modal').addEventListener('click', () => {
            document.getElementById('clear-data-modal').classList.remove('hidden');
        });

        document.getElementById('btn-open-about-app-modal').addEventListener('click', () => {
            document.getElementById('about-app-modal').classList.remove('hidden');
        });

        document.getElementById('btn-open-about-modal').addEventListener('click', () => {
            document.getElementById('about-modal').classList.remove('hidden');
        });

        // Delete Confirmation Logic
        let deleteTargetType = '';
        let deleteTargetId = '';

        window.openDeleteConfirm = function (type, id, title, msg) {
            deleteTargetType = type;
            deleteTargetId = id;
            document.getElementById('delete-modal-title').innerText = title;
            document.getElementById('delete-modal-msg').innerText = msg;
            document.getElementById('delete-confirm-modal').classList.remove('hidden');
        };

        document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
            await executeDelete(deleteTargetType, deleteTargetId);
            document.getElementById('delete-confirm-modal').classList.add('hidden');
        });

        document.getElementById('btn-confirm-clear').addEventListener('click', async () => {
            await executeClearData();
            document.getElementById('clear-data-modal').classList.add('hidden');
        });

        document.getElementById('btn-logout').addEventListener('click', async () => {
            await supabaseClient.auth.signOut();
            currentUser = null;
            AppStorage.reset();
            updateLogic();
        });

        // Practice Actions
        window.openEditPractice = function (dateStr) {
            const db = AppStorage.get();
            const log = db.practiceLogs[dateStr];
            if (!log) return;
            document.getElementById('prac-edit-date-old').value = dateStr;
            document.getElementById('prac-edit-date').value = dateStr;
            document.getElementById('prac-edit-p').value = log.p;
            document.getElementById('prac-edit-c').value = log.c;
            document.getElementById('prac-edit-m').value = log.m;
            document.getElementById('prac-edit-modal').classList.remove('hidden');
        };

        document.getElementById('form-practice-edit').addEventListener('submit', async function (e) {
            e.preventDefault();
            const oldDStr = document.getElementById('prac-edit-date-old').value;
            const newDStr = document.getElementById('prac-edit-date').value;

            const p = parseInt(document.getElementById('prac-edit-p').value || 0);
            const c = parseInt(document.getElementById('prac-edit-c').value || 0);
            const m = parseInt(document.getElementById('prac-edit-m').value || 0);

            if (oldDStr !== newDStr) {
                await executeDelete('practice', oldDStr);
            }
            await savePracticeLog(newDStr, p, c, m);
            document.getElementById('prac-edit-modal').classList.add('hidden');
        });

        document.getElementById('form-practice').addEventListener('submit', async function (e) {
            e.preventDefault();
            const db = AppStorage.get();
            const todayStr = getLocalDateStr(new Date());

            let p = parseInt(document.getElementById('prac-p').value || 0);
            let c = parseInt(document.getElementById('prac-c').value || 0);
            let m = parseInt(document.getElementById('prac-m').value || 0);

            if (db.practiceLogs[todayStr]) {
                p += db.practiceLogs[todayStr].p;
                c += db.practiceLogs[todayStr].c;
                m += db.practiceLogs[todayStr].m;
            }

            await savePracticeLog(todayStr, p, c, m);
            playTaskCompleteSound();

            document.getElementById('prac-p').value = '';
            document.getElementById('prac-c').value = '';
            document.getElementById('prac-m').value = '';

            const btn = this.querySelector('button');
            btn.innerText = "Logged Successfully!";
            btn.classList.add('bg-green-600', 'text-white');
            btn.classList.remove('bg-black', 'dark:bg-white', 'text-white', 'dark:text-black');

            setTimeout(() => {
                btn.innerText = "Log Questions";
                btn.classList.remove('bg-green-600', 'text-white');
                btn.classList.add('bg-black', 'dark:bg-white', 'text-white', 'dark:text-black');
            }, 2000);
        });

        // Mock Actions
        window.openEditMock = function (id) {
            const db = AppStorage.get();
            const mock = db.mocks.find(m => m.id === id);
            if (!mock) return;
            document.getElementById('mock-edit-id').value = mock.id;
            document.getElementById('mock-name').value = mock.name;
            document.getElementById('mock-date').value = getLocalDateStr(new Date(mock.date));

            const totalMins = parseInt(mock.timeTaken) || 0;
            document.getElementById('mock-time-h').value = Math.floor(totalMins / 60) || "0";
            document.getElementById('mock-time-m').value = (totalMins % 60) || "0";

            document.getElementById('mock-max').value = mock.maxMarks || 100;
            document.getElementById('mock-c').value = mock.correct;
            document.getElementById('mock-i').value = mock.incorrect;
            document.getElementById('mock-s').value = mock.skipped;
            document.getElementById('mock-modal-title').innerText = "Edit Mock Test";
            document.getElementById('mock-modal').classList.remove('hidden');
        };

        document.getElementById('form-mock').addEventListener('submit', async function (e) {
            e.preventDefault();
            const editId = document.getElementById('mock-edit-id').value;
            const mockDateStr = document.getElementById('mock-date').value;

            const h = parseInt(document.getElementById('mock-time-h').value) || 0;
            const m = parseInt(document.getElementById('mock-time-m').value) || 0;
            const totalMins = (h * 60) + m;

            const mockData = {
                id: editId || generateId(),
                date: new Date(mockDateStr).toISOString(),
                name: document.getElementById('mock-name').value,
                timeTaken: totalMins,
                maxMarks: document.getElementById('mock-max').value,
                correct: document.getElementById('mock-c').value,
                incorrect: document.getElementById('mock-i').value,
                skipped: document.getElementById('mock-s').value
            };

            await saveMockTest(mockData, !!editId);
            document.getElementById('mock-modal').classList.add('hidden');
        });

        // Revision Actions
        window.openEditTopic = function (id) {
            const db = AppStorage.get();
            const topic = db.topics.find(t => t.id === id);
            if (!topic) return;
            document.getElementById('rev-edit-id').value = topic.id;
            document.getElementById('rev-edit-topic-name').value = topic.name;

            const d = topic.firstDate ? new Date(topic.firstDate) : new Date(topic.lastReviewed);
            document.getElementById('rev-edit-date').value = getLocalDateStr(d);
            document.getElementById('rev-edit-count-total').value = topic.maxRevisions || 10;

            document.getElementById('rev-edit-modal').classList.remove('hidden');
        };

        document.getElementById('form-revision-edit').addEventListener('submit', async function (e) {
            e.preventDefault();
            const db = AppStorage.get();
            const id = document.getElementById('rev-edit-id').value;
            const index = db.topics.findIndex(t => t.id === id);

            if (index !== -1) {
                const topicData = { ...db.topics[index] };
                const newDateStr = new Date(document.getElementById('rev-edit-date').value).toISOString();

                topicData.name = document.getElementById('rev-edit-topic-name').value;
                topicData.maxRevisions = parseInt(document.getElementById('rev-edit-count-total').value);

                if (topicData.firstDate !== newDateStr) {
                    topicData.firstDate = newDateStr;
                    topicData.lastReviewed = newDateStr;
                    topicData.reviewCount = 0;
                }
                await saveTopic(topicData, true);
            }
            document.getElementById('rev-edit-modal').classList.add('hidden');
        });

        window.markRevisionDone = async function (id) {
            const db = AppStorage.get();
            const topic = db.topics.find(t => t.id === id);
            if (topic) {
                const topicData = { ...topic };
                topicData.lastReviewed = new Date().toISOString();
                topicData.reviewCount += 1;
                await saveTopic(topicData, true);
                playTaskCompleteSound();
            }
        };

        document.getElementById('form-revision').addEventListener('submit', async function (e) {
            e.preventDefault();
            const dStr = document.getElementById('rev-date').value;
            const topicData = {
                id: generateId(),
                name: document.getElementById('rev-topic-name').value,
                completed: true,
                firstDate: new Date(dStr).toISOString(),
                lastReviewed: new Date(dStr).toISOString(),
                reviewCount: 0,
                maxRevisions: parseInt(document.getElementById('rev-count-total').value)
            };
            await saveTopic(topicData, false);
            this.reset();
            document.getElementById('rev-modal').classList.add('hidden');
        });

        // Add Task Events
        document.getElementById('btn-add-task')?.addEventListener('click', () => {
            const input = document.getElementById('new-task-input');
            const dateInput = document.getElementById('new-task-date');
            const text = input.value.trim();
            const selectedDate = dateInput.value;
            if (text) {
                saveTask(text, selectedDate);
                input.value = '';
                dateInput.value = getLocalDateStr(new Date()); // Reset to today
                document.getElementById('tag-suggestions-container')?.classList.add('hidden');
            }
        });

        document.getElementById('new-task-input')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const text = e.target.value.trim();
                const dateInput = document.getElementById('new-task-date');
                const selectedDate = dateInput.value;
                if (text) {
                    saveTask(text, selectedDate);
                    e.target.value = '';
                    dateInput.value = getLocalDateStr(new Date()); // Reset to today
                    document.getElementById('tag-suggestions-container')?.classList.add('hidden');
                }
            }
        });

        document.getElementById('btn-add-hashtag')?.addEventListener('click', () => {
            const input = document.getElementById('new-task-input');
            input.value += (input.value.length > 0 && !input.value.endsWith(' ') ? ' #' : '#');
            input.focus();
            input.dispatchEvent(new Event('input'));
        });

        document.getElementById('btn-clear-task-input')?.addEventListener('click', () => {
            const input = document.getElementById('new-task-input');
            input.value = '';
            input.focus();
            document.getElementById('tag-suggestions-container')?.classList.add('hidden');
        });

        // Tag Suggestions Logic
        function getUsedTags() {
            const db = AppStorage.get();
            const tagMap = {};
            (db.tasks || []).forEach(t => {
                const matches = (t.text || '').match(/(?:^|\s)#([\w-]+)/g);
                if (matches) {
                    matches.forEach(m => {
                        const tag = m.trim().replace('#', '');
                        tagMap[tag] = (tagMap[tag] || 0) + 1;
                    });
                }
            });
            const deletedTags = db.deletedTags || [];
            return Object.keys(tagMap)
                .filter(tag => !deletedTags.includes(tag))
                .sort((a, b) => tagMap[b] - tagMap[a]);
        }

        function renderTagSuggestions(filterText = '') {
            const tags = getUsedTags();
            const container = document.getElementById('tag-suggestions-container');
            const list = document.getElementById('tag-suggestions-list');

            if (!container || !list) return;

            const filteredTags = tags.filter(t => t.toLowerCase().includes(filterText.toLowerCase()));

            if (filteredTags.length === 0) {
                container.classList.add('hidden');
                return;
            }

            list.innerHTML = '';
            filteredTags.forEach(tag => {
                const pill = document.createElement('div');
                pill.className = "flex items-center gap-1 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-2 py-1 rounded-md text-xs font-bold border border-blue-200 dark:border-blue-800 cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors";

                const textSpan = document.createElement('span');
                textSpan.innerText = '#' + tag;
                textSpan.onclick = () => insertTag(tag);

                const delBtn = document.createElement('button');
                delBtn.className = "ml-1 text-blue-400 hover:text-red-500 transition-colors font-black text-sm";
                delBtn.innerHTML = "&times;";
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    deleteTagSuggestion(tag);
                };

                pill.appendChild(textSpan);
                pill.appendChild(delBtn);
                list.appendChild(pill);
            });

            container.classList.remove('hidden');
        }

        function insertTag(tag) {
            const input = document.getElementById('new-task-input');
            const words = input.value.split(' ');
            words[words.length - 1] = '#' + tag + ' ';
            input.value = words.join(' ');
            input.focus();
            document.getElementById('tag-suggestions-container').classList.add('hidden');
        }

        window.deleteTagSuggestion = function (tag) {
            const db = AppStorage.get();
            if (!db.deletedTags) db.deletedTags = [];
            db.deletedTags.push(tag);
            AppStorage.saveLocal();

            const input = document.getElementById('new-task-input');
            const words = input.value.split(' ');
            const lastWord = words[words.length - 1];
            renderTagSuggestions(lastWord.startsWith('#') ? lastWord.slice(1) : '');
        };

        document.getElementById('new-task-input')?.addEventListener('input', (e) => {
            const words = e.target.value.split(' ');
            const lastWord = words[words.length - 1];

            if (lastWord.startsWith('#')) {
                renderTagSuggestions(lastWord.slice(1));
            } else {
                document.getElementById('tag-suggestions-container')?.classList.add('hidden');
            }
        });

        // Hide tag suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.group')) {
                document.getElementById('tag-suggestions-container')?.classList.add('hidden');
            }
        });

        // Task Options Actions
        let currentTaskTarget = '';
        let currentTaskText = '';
        let currentTaskDate = '';

        window.openTaskOptions = function (id, text, date, completed = false) {
            currentTaskTarget = id;
            currentTaskText = text;
            currentTaskDate = date;

            const toggleText = document.getElementById('text-task-opt-toggle');
            const toggleIcon = document.getElementById('icon-task-opt-toggle');

            if (toggleText && toggleIcon) {
                if (completed) {
                    toggleText.innerText = 'Mark as Undone';
                    toggleIcon.className = 'w-5 h-5 text-yellow-500';
                    toggleIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path>';
                } else {
                    toggleText.innerText = 'Mark as Done';
                    toggleIcon.className = 'w-5 h-5 text-green-500';
                    toggleIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>';
                }
            }

            document.getElementById('task-options-modal').classList.remove('hidden');
        };

        document.getElementById('btn-task-opt-toggle').addEventListener('click', () => {
            document.getElementById('task-options-modal').classList.add('hidden');
            if (currentTaskTarget) {
                toggleTask(currentTaskTarget);
            }
        });

        document.getElementById('btn-task-opt-edit').addEventListener('click', () => {
            document.getElementById('task-options-modal').classList.add('hidden');
            document.getElementById('task-edit-input').value = currentTaskText;

            let dateVal = getLocalDateStr(new Date());
            if (currentTaskDate) {
                dateVal = getLocalDateStr(new Date(currentTaskDate));
            }
            document.getElementById('task-edit-date').value = dateVal;

            document.getElementById('task-edit-modal').classList.remove('hidden');
        });

        document.getElementById('btn-task-opt-dup').addEventListener('click', () => {
            document.getElementById('task-options-modal').classList.add('hidden');
            saveTask(currentTaskText);
        });

        document.getElementById('btn-task-opt-del').addEventListener('click', () => {
            document.getElementById('task-options-modal').classList.add('hidden');
            openDeleteConfirm('task', currentTaskTarget, 'Delete Task?', 'Are you sure you want to delete this task?');
        });

        document.getElementById('form-task-edit').addEventListener('submit', async function (e) {
            e.preventDefault();
            const newText = document.getElementById('task-edit-input').value.trim();
            const newDateStr = document.getElementById('task-edit-date').value;

            if (newText) {
                const db = AppStorage.get();
                const taskIndex = db.tasks.findIndex(t => t.id === currentTaskTarget);
                if (taskIndex !== -1) {
                    db.tasks[taskIndex].text = newText;

                    if (newDateStr) {
                        const parts = newDateStr.split('-');
                        if (parts.length === 3) {
                            const oldDate = new Date(db.tasks[taskIndex].created_at || new Date());
                            const customDate = new Date(parts[0], parts[1] - 1, parts[2], oldDate.getHours(), oldDate.getMinutes(), oldDate.getSeconds());
                            db.tasks[taskIndex].created_at = customDate.toISOString();
                        }
                    }

                    AppStorage.saveLocal();
                    updateLogic();

                    if (currentUser) {
                        await supabaseClient.from('tasks').update({
                            task_text: newText,
                            created_at: db.tasks[taskIndex].created_at
                        }).eq('id', currentTaskTarget);
                    }
                }
                document.getElementById('task-edit-modal').classList.add('hidden');
            }
        });

        // Import / Export
        document.getElementById('btn-export').addEventListener('click', () => {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(AppStorage.get()));
            const dlAnchorElem = document.createElement('a');
            dlAnchorElem.setAttribute("href", dataStr);
            dlAnchorElem.setAttribute("download", "Prepify_Backup.json");
            dlAnchorElem.click();
        });

        document.getElementById('btn-import').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    AppStorage.memory = data;
                    AppStorage.saveLocal();
                    updateLogic();

                    // Sync loaded data to new schema
                    if (currentUser) {
                        for (const [date, logs] of Object.entries(data.practiceLogs || {})) {
                            await savePracticeLog(date, logs.p, logs.c, logs.m);
                        }
                        for (const mock of data.mocks || []) {
                            if (!mock.id || mock.id.length < 15) mock.id = generateId();
                            await saveMockTest(mock, false);
                        }
                        for (const topic of data.topics || []) {
                            if (!topic.id || topic.id.length < 15) topic.id = generateId();
                            await saveTopic(topic, false);
                        }
                    }
                    alert('Data imported successfully and synced to Database!');
                } catch (err) { alert('Invalid backup file.'); }
            };
            reader.readAsText(file);
        });

        // Navigation
        const navItems = document.querySelectorAll('.nav-item');
        const sections = document.querySelectorAll('.view-section');
        const mainHeaderTitle = document.getElementById('main-header-title');

        navItems.forEach(item => {
            item.addEventListener('click', () => {
                navItems.forEach(n => n.classList.remove('active'));
                item.classList.add('active');

                const target = item.getAttribute('data-target');

                // Update Main Header Text dynamically
                if (mainHeaderTitle) {
                    mainHeaderTitle.innerText = target === 'home' ? 'Practice' : target === 'tasks' ? 'Tasks' : target === 'mocks' ? 'Mock Tests' : target === 'settings' ? 'Settings' : target === 'revision' ? 'Revision' : target === 'dashboard' ? 'Dashboard' : 'Prepify';
                }

                sections.forEach(s => {
                    s.classList.remove('active');
                    if (s.id === `view-${target}`) {
                        s.classList.add('active');
                        document.querySelector('main').scrollTo({ top: 0, behavior: 'smooth' });
                        if (target === 'dashboard') {
                            setTimeout(() => {
                                renderDashboard();
                                renderPracticeChart();
                                renderTaskCompletionChart();
                                renderTaskHeatmap();
                                renderTaskPieChart();
                                renderRadarChart();
                                renderRollingAvgChart();
                                renderHealthScore();
                            }, 10);
                        }
                    }
                });
            });
        });

        // Initialize & Auth Logic
        async function checkUser() {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session) {
                currentUser = session.user;
                document.getElementById('auth-overlay').classList.add('hidden');

                // Update Profile UI
                document.getElementById('profile-email').innerText = currentUser.email;
                document.getElementById('profile-name').innerText = currentUser.email.split('@')[0];

                // Try fetching avatar from public.profiles
                try {
                    const { data: profile } = await supabaseClient.from('profiles').select('avatar_url').eq('id', currentUser.id).single();
                    if (profile && profile.avatar_url) {
                        document.getElementById('profile-pic-img').src = profile.avatar_url;
                    }
                } catch (e) { }

                await AppStorage.loadFromSupabase();
            } else {
                document.getElementById('auth-overlay').classList.remove('hidden');
            }
        }

        // Profile Picture Upload Logic
        const btnProfilePic = document.getElementById('btn-profile-pic');
        if (btnProfilePic) {
            btnProfilePic.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file || !currentUser) return;

                if (file.size > 1024 * 1024) {
                    showToast('File size must be under 1 MB!', 'error');
                    e.target.value = '';
                    return;
                }

                showToast('Uploading picture...', 'success');

                const fileExt = file.name.split('.').pop();
                const filePath = `${currentUser.id}/avatar.${fileExt}`;

                try {
                    const { error: uploadError } = await supabaseClient.storage
                        .from('avatars')
                        .upload(filePath, file, { upsert: true });

                    if (uploadError) throw uploadError;

                    const { data: { publicUrl } } = supabaseClient.storage
                        .from('avatars')
                        .getPublicUrl(filePath);

                    const { error: updateError } = await supabaseClient.from('profiles')
                        .upsert({ id: currentUser.id, avatar_url: publicUrl });

                    if (updateError) throw updateError;

                    document.getElementById('profile-pic-img').src = publicUrl;
                    showToast('Profile picture updated!', 'success');
                } catch (error) {
                    showToast('Failed to upload picture. Setup SQL first!', 'error');
                }
            });
        }

        let authMode = 'login';
        document.getElementById('auth-toggle-mode').addEventListener('click', () => {
            authMode = authMode === 'login' ? 'signup' : 'login';
            document.getElementById('auth-subtitle').innerText = authMode === 'login' ? 'Think. Prep. Done.' : 'Sign up to start tracking';
            document.querySelector('#auth-btn span').innerText = authMode === 'login' ? 'Login' : 'Sign Up';
            document.getElementById('auth-toggle-mode').innerText = authMode === 'login' ? "Don't have an account? Sign up" : "Already have an account? Login";

            // Toggle Password Strength visibility
            const strengthContainer = document.getElementById('password-strength-container');
            if (authMode === 'signup') {
                strengthContainer.classList.remove('hidden');
                setTimeout(() => strengthContainer.classList.remove('opacity-0'), 10); // Small delay to let display:flex apply
                evaluatePasswordStrength(document.getElementById('auth-password').value);
            } else {
                strengthContainer.classList.add('opacity-0');
                setTimeout(() => strengthContainer.classList.add('hidden'), 300);
            }
        });

        // Toast Notification System
        function showToast(message, type = 'error') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            const bgClass = type === 'error' ? 'bg-red-500 shadow-red-500/30' : 'bg-green-500 shadow-green-500/30';
            const icon = type === 'error'
                ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>'
                : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>';

            toast.className = `px-4 py-3.5 rounded-xl shadow-2xl text-sm font-bold text-white flex items-center gap-3 transform transition-all duration-500 -translate-y-10 opacity-0 ${bgClass}`;
            toast.innerHTML = `
                <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icon}</svg>
                <span>${message}</span>
            `;

            container.appendChild(toast);

            // Animate In
            requestAnimationFrame(() => {
                toast.classList.remove('-translate-y-10', 'opacity-0');
                toast.classList.add('translate-y-0', 'opacity-100');
            });

            // Animate Out
            setTimeout(() => {
                toast.classList.remove('translate-y-0', 'opacity-100');
                toast.classList.add('-translate-y-4', 'opacity-0');
                setTimeout(() => toast.remove(), 500);
            }, 3500);
        }

        // Password Strength Logic
        const strengthText = document.getElementById('password-strength-text');
        const bars = [
            document.getElementById('strength-bar-1'),
            document.getElementById('strength-bar-2'),
            document.getElementById('strength-bar-3'),
            document.getElementById('strength-bar-4')
        ];

        function evaluatePasswordStrength(password) {
            let score = 0;
            if (!password) {
                updateStrengthUI(0, '---', 'text-gray-400', '');
                return;
            }

            if (password.length >= 8) score += 1;
            if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
            if (/\d/.test(password)) score += 1;
            if (/[^a-zA-Z0-9]/.test(password)) score += 1;

            if (password.length > 0 && password.length < 6) score = 1; // Enforce weak if too short

            switch (score) {
                case 1: updateStrengthUI(1, 'Weak', 'text-red-500', 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]'); break;
                case 2: updateStrengthUI(2, 'Fair', 'text-yellow-500', 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.4)]'); break;
                case 3: updateStrengthUI(3, 'Good', 'text-blue-500', 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.4)]'); break;
                case 4: updateStrengthUI(4, 'Strong', 'text-green-500', 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]'); break;
                default: updateStrengthUI(1, 'Weak', 'text-red-500', 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]'); break;
            }
        }

        function updateStrengthUI(activeBars, text, textColor, bgColorClass) {
            strengthText.innerText = text;
            strengthText.className = `text-[10px] font-black uppercase tracking-wider transition-colors duration-300 ${textColor}`;

            bars.forEach((bar, index) => {
                if (index < activeBars) {
                    bar.className = `h-full flex-1 rounded-full transition-all duration-300 ${bgColorClass}`;
                } else {
                    bar.className = `h-full flex-1 rounded-full transition-all duration-300 bg-gray-200 dark:bg-gray-700 shadow-none`;
                }
            });
        }

        // Modern Animated Password Visibility Toggle
        const togglePasswordBtn = document.getElementById('toggle-password-btn');
        const passwordInput = document.getElementById('auth-password');
        const eyeShow = document.getElementById('eye-icon-show');
        const eyeHide = document.getElementById('eye-icon-hide');

        if (togglePasswordBtn && passwordInput) {
            // Strength Evaluator Listener
            passwordInput.addEventListener('input', (e) => {
                if (authMode === 'signup') {
                    evaluatePasswordStrength(e.target.value);
                }
            });

            togglePasswordBtn.addEventListener('click', () => {
                if (passwordInput.type === 'password') {
                    // Switch to Text
                    passwordInput.type = 'text';

                    // Animate Eye Hide (slash) out
                    eyeHide.classList.remove('scale-100', 'opacity-100', 'rotate-0');
                    eyeHide.classList.add('scale-50', 'opacity-0', 'rotate-45');

                    // Animate Eye Show in
                    eyeShow.classList.remove('scale-50', 'opacity-0', '-rotate-45');
                    eyeShow.classList.add('scale-100', 'opacity-100', 'rotate-0');
                } else {
                    // Switch back to Password
                    passwordInput.type = 'password';

                    // Animate Eye Show out
                    eyeShow.classList.remove('scale-100', 'opacity-100', 'rotate-0');
                    eyeShow.classList.add('scale-50', 'opacity-0', '-rotate-45');

                    // Animate Eye Hide (slash) in
                    eyeHide.classList.remove('scale-50', 'opacity-0', 'rotate-45');
                    eyeHide.classList.add('scale-100', 'opacity-100', 'rotate-0');
                }
            });
        }

        document.getElementById('auth-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('auth-email').value;
            const password = document.getElementById('auth-password').value;
            const btnText = document.querySelector('#auth-btn span');
            btnText.innerText = 'Please wait...';

            if (authMode === 'login') {
                const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
                if (error) {
                    if (error.message.includes('Invalid login credentials')) {
                        showToast('No Account Found !!', 'error');
                    } else {
                        showToast(error.message, 'error');
                    }
                }
                else {
                    document.getElementById('auth-form').reset();
                    await checkUser();
                }
            } else {
                const { error } = await supabaseClient.auth.signUp({ email, password });
                if (error) showToast(error.message, 'error');
                else {
                    showToast('Signup successful! You can now login.', 'success');
                    authMode = 'login';
                    document.getElementById('auth-subtitle').innerText = 'Think. Prep. Done.';
                    document.querySelector('#auth-btn span').innerText = 'Login';
                    document.getElementById('auth-toggle-mode').innerText = "Don't have an account? Sign up";
                }
            }
            btnText.innerText = authMode === 'login' ? 'Login' : 'Sign Up';
        });

        supabaseClient.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN') {
                checkUser();
            } else if (event === 'SIGNED_OUT') {
                currentUser = null;
                document.getElementById('auth-overlay').classList.remove('hidden');
            }
        });

        AppStorage.load();
        updateLogic();
        checkUser();

        // Initialize task date input to today
        const newTaskDateInput = document.getElementById('new-task-date');
        if (newTaskDateInput) {
            newTaskDateInput.value = getLocalDateStr(new Date());
        }
