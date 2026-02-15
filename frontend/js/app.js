document.addEventListener('DOMContentLoaded', () => {
    const chatContainer = document.getElementById('chat-messages');
    const messageInput = document.getElementById('messageInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const fileInput = document.getElementById('fileInput');
    const modelSelect = document.getElementById('modelSelect');
    const themeToggle = document.getElementById('themeToggle');
    const micBtn = document.getElementById('micBtn');
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
    const recordingVisualizer = document.getElementById('recordingVisualizer');
    // TTS button removed from global scope

    // --- State Management ---
    let isRecording = false;
    let mediaRecorder = null;
    let audioChunks = [];
    let attachedFiles = []; // Store files to be uploaded

    // User Context for Storage Isolation
    const currentUser = localStorage.getItem('username');
    const userRole = localStorage.getItem('user_role');
    const storageKey = currentUser ? `chat_sessions_${currentUser}` : 'chat_sessions_guest';
    const sessionIdKey = currentUser ? `current_session_id_${currentUser}` : 'current_session_id_guest';

    let chatSessions = JSON.parse(localStorage.getItem(storageKey) || '{}');
    let abortController = null; // For stopping generation

    // Helper to save sessions
    function saveSessions() {
        localStorage.setItem(storageKey, JSON.stringify(chatSessions));
    }


    // Theme (keep existing logic)
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    // Session (New Logic)
    let currentSessionId = localStorage.getItem(sessionIdKey);

    // Sidebar Elements
    const historySidebar = document.getElementById('historySidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const closeSidebar = document.getElementById('closeSidebar');
    const sessionList = document.getElementById('sessionList');
    const newChatBtn = document.getElementById('newChatBtn');
    const fileChips = document.getElementById('fileChips');

    // Validate session ownership and existence
    if (currentSessionId && !chatSessions[currentSessionId]) {
        // Session ID exists but not in user's sessions - either orphaned or belongs to another user
        // Clear it and create fresh
        localStorage.removeItem(sessionIdKey);
        currentSessionId = null;
    }

    // If no currentSessionId, try to use the most recent session from history
    if (!currentSessionId && Object.keys(chatSessions).length > 0) {
        const sortedSessions = Object.values(chatSessions).sort((a, b) => b.timestamp - a.timestamp);
        if (sortedSessions.length > 0) {
            currentSessionId = sortedSessions[0].id;
            localStorage.setItem(sessionIdKey, currentSessionId);
        }
    }

    // Load session history if we have a valid session
    if (currentSessionId) {
        loadSessionHistory(currentSessionId);
    }
    // If no session at all, just show welcome screen - don't auto-create

    renderSessionList();

    // --- Initialization ---
    fetchModels();

    async function fetchModels() {
        try {
            const response = await fetch('/api/models');
            const data = await response.json();

            modelSelect.innerHTML = '';

            if (data.models && data.models.length > 0) {
                // Sort models explicitly if needed, or rely on API order
                // Prioritize llama-3.3 if exists
                const sortedModels = data.models.filter(model => {
                    const id = model.id.toLowerCase();
                    // Filter out audio, whisper, vision, etc. if user wants text-to-text only
                    // "text to text jangan ada model STT"
                    if (id.includes('whisper')) return false;
                    if (id.includes('audio')) return false;
                    if (id.includes('tts')) return false;
                    if (id.includes('stt')) return false;
                    if (id.includes('vision') && !id.includes('llama-3.2-11b-vision')) return false; // Optional: keep vision-text models? User said text to text.
                    // Strict text check?
                    return true;
                }).sort((a, b) => {
                    if (a.id.includes('3.3-70b')) return -1;
                    if (b.id.includes('3.3-70b')) return 1;
                    return 0;
                });

                sortedModels.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model.id;
                    option.textContent = `${model.id} (${model.owned_by})`;
                    modelSelect.appendChild(option);
                });
            } else {
                const option = document.createElement('option');
                option.text = "No models available";
                modelSelect.appendChild(option);
            }
        } catch (error) {
            console.error("Failed to fetch models:", error);
            modelSelect.innerHTML = '<option value="llama-3.3-70b-versatile">Llama 3.3 70B (Fallback)</option>';
        }
    }

    // --- Audio Functions ---
    let currentSpeakingButton = null;

    function speak(text, btn) {
        // If currently speaking
        if (window.speechSynthesis.speaking) {
            // If clicked the same button, stop and reset
            if (currentSpeakingButton === btn) {
                window.speechSynthesis.cancel();
                resetSpeakingButton();
                return;
            } else {
                // If clicked a different button, stop previous and continue to start new
                window.speechSynthesis.cancel();
                resetSpeakingButton();
            }
        }

        // Start new speech
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'id-ID';

        // Setup visual state
        currentSpeakingButton = btn;
        if (btn) {
            // Change icon to Square (Stop)
            const icon = btn.querySelector('i') || btn.querySelector('svg'); // Lucide might replace <i> with <svg>
            if (icon) {
                // We can't easily change lucide icon class after render without re-calling createIcons or manipulating SVG
                // Easiest is to replace innerHTML
                btn.innerHTML = '<i data-lucide="square" class="w-4 h-4 fill-current text-red-500"></i>';
                lucide.createIcons();
            }
        }

        utterance.onend = () => {
            resetSpeakingButton();
        };

        utterance.onerror = () => {
            resetSpeakingButton();
        };

        window.speechSynthesis.speak(utterance);
    }

    function resetSpeakingButton() {
        if (currentSpeakingButton) {
            // Revert icon to Volume-2
            currentSpeakingButton.innerHTML = '<i data-lucide="volume-2" class="w-4 h-4"></i>';
            lucide.createIcons();
            currentSpeakingButton = null;
        }
    }

    async function startRecording() {
        try {
            // First, check if getUserMedia is available
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                alert('Your browser does not support audio recording.\n\nPlease use a modern browser like Chrome, Edge, or Firefox.');
                return;
            }

            console.log('Requesting microphone access...');
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log('Microphone access granted. Stream:', stream);

            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = (event) => {
                audioChunks.push(event.data);
                console.log('Audio chunk received:', event.data.size, 'bytes');
            };

            mediaRecorder.onstop = async () => {
                console.log('Recording stopped. Total chunks:', audioChunks.length);
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                console.log('Audio blob size:', audioBlob.size, 'bytes');

                if (audioBlob.size === 0) {
                    console.error("Recorded audio is empty");
                    alert("Recording failed: Audio is empty. Please check your microphone.");
                    return;
                }

                // Convert to file with explicit name and type
                const file = new File([audioBlob], "recording.webm", { type: 'audio/webm' });
                await transcribeAudio(file);
            };

            mediaRecorder.start();
            isRecording = true;
            micBtn.classList.add('bg-red-600', 'animate-pulse');
            // Show visualizer
            if (recordingVisualizer) {
                recordingVisualizer.classList.remove('hidden');
            }
            console.log('Recording started successfully');
        } catch (err) {
            console.error('Error accessing microphone:', err);

            let errorMessage = 'Microphone access failed:\n\n';

            if (err.name === 'NotReadableError') {
                errorMessage += '❌ Microphone is not readable. Possible causes:\n' +
                    '1. Another application is exclusively using the microphone.\n' +
                    '2. Windows Privacy Settings blocked desktop apps.\n' +
                    '3. Hardware issue (unplugged or muted).\n\n' +
                    'Try checking: Settings > Privacy > Microphone > "Allow desktop apps to access your microphone".';
            } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                errorMessage += '❌ Microphone permission denied. Please allow access in browser settings.\n';
            } else if (err.name === 'NotFoundError') {
                errorMessage += '❌ No microphone found. Please connect a microphone.\n';
            } else {
                errorMessage += `❌ Error: ${err.message}\n`;
            }

            alert(errorMessage);
        }
    }

    function stopRecording() {
        if (mediaRecorder && isRecording) {
            mediaRecorder.stop();
            isRecording = false;
            micBtn.classList.remove('bg-red-600', 'animate-pulse');
            // Hide visualizer
            if (recordingVisualizer) {
                recordingVisualizer.classList.add('hidden');
            }
            // Stop stream tracks
            mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
    }

    async function transcribeAudio(file) {
        const formData = new FormData();
        formData.append('file', file);

        // Show loading state in input
        const originalPlaceholder = messageInput.placeholder;
        messageInput.placeholder = "Transcribing...";
        messageInput.disabled = true;

        try {
            const response = await fetch('/api/transcribe', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            if (response.ok) {
                messageInput.value += (messageInput.value ? " " : "") + data.text;
                toggleInputButtons(); // Update buttons
                // Auto send? Maybe just let user send.
                // messageInput.focus();
            } else {
                console.error("Transcription failed:", data.detail);
            }
        } catch (err) {
            console.error("Transcription error:", err);
        } finally {
            messageInput.placeholder = originalPlaceholder;
            messageInput.disabled = false;
            messageInput.focus();
        }
    }

    // --- UI Helper Functions ---
    function toggleInputButtons() {
        const text = messageInput.value.trim();
        if (text.length > 0 || attachedFiles.length > 0) {
            micBtn.classList.add('hidden');
            sendBtn.classList.remove('hidden');
        } else {
            micBtn.classList.remove('hidden');
            sendBtn.classList.add('hidden');
        }
    }

    function scrollToBottom() {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function addMessage(text, isUser = false) {
        const wrapper = document.createElement('div');
        wrapper.className = 'flex gap-4 ' + (isUser ? 'justify-end' : '');

        const avatar = document.createElement('div');
        avatar.className = `w-10 h-10 rounded-full flex items-center justify-center shrink-0 shadow-lg ${isUser ? 'bg-gradient-to-br from-blue-500 to-purple-600 order-last' : 'bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border border-white/20'}`;
        avatar.innerHTML = `<i data-lucide="${isUser ? 'user' : 'bot'}" class="${isUser ? 'text-white' : 'text-gray-900 dark:text-white'} w-6 h-6"></i>`;

        const contentContainer = document.createElement('div');
        contentContainer.className = "flex flex-col gap-1 max-w-[85%]";

        // Message Bubble
        const content = document.createElement('div');
        const baseClasses = "p-4 text-sm md:text-base break-words leading-relaxed shadow-sm relative group backdrop-blur-md";
        // Styling handled mostly by CSS classes .user-msg and .ai-msg now
        const userClasses = "user-msg";
        const aiClasses = "ai-msg";

        content.className = `${baseClasses} ${isUser ? userClasses : aiClasses}`;
        content.textContent = text;

        // TTS Button for AI messages
        if (!isUser) {
            const ttsBtn = document.createElement('button');
            ttsBtn.className = "absolute -bottom-6 left-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity p-1 cursor-pointer";
            ttsBtn.innerHTML = '<i data-lucide="volume-2" class="w-4 h-4"></i>';
            ttsBtn.title = "Read Aloud";
            ttsBtn.onclick = function () { speak(content.textContent, this); };
            content.appendChild(ttsBtn);
        }

        contentContainer.appendChild(content);

        if (isUser) {
            wrapper.innerHTML = '';
            wrapper.appendChild(contentContainer);
            wrapper.appendChild(avatar);
            contentContainer.classList.add('items-end');
        } else {
            wrapper.appendChild(avatar);
            wrapper.appendChild(contentContainer);
        }

        chatContainer.querySelector('.max-w-5xl').appendChild(wrapper);
        lucide.createIcons();
        scrollToBottom();

        // Hide welcome message
        const welcomeMsg = document.getElementById('welcome-message');
        if (welcomeMsg && !welcomeMsg.classList.contains('hidden')) {
            welcomeMsg.classList.add('hidden');
        }

        return content;
    }

    function showTyping() {
        const wrapper = document.createElement('div');
        wrapper.id = 'typing-indicator';
        wrapper.className = 'flex gap-4';

        const avatar = document.createElement('div');
        avatar.className = 'w-10 h-10 rounded-full bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border border-white/20 flex items-center justify-center shrink-0 shadow-lg';
        avatar.innerHTML = '<i data-lucide="bot" class="text-gray-900 dark:text-white w-6 h-6"></i>';

        const content = document.createElement('div');
        content.className = 'glass p-4 rounded-3xl rounded-tl-none border border-white/20 shadow-sm flex items-center h-14';
        content.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';

        wrapper.appendChild(avatar);
        wrapper.appendChild(content);

        // Hide welcome message
        const welcomeMsg = document.getElementById('welcome-message');
        if (welcomeMsg && !welcomeMsg.classList.contains('hidden')) {
            welcomeMsg.classList.add('hidden');
        }

        chatContainer.querySelector('.max-w-5xl').appendChild(wrapper);
        lucide.createIcons();
        scrollToBottom();
    }
    // --- Streaming Logic ---
    async function sendMessage() {
        const text = messageInput.value.trim();
        const model = modelSelect.value;

        // Validate BEFORE processing files
        if (!text && attachedFiles.length === 0) {
            console.log('sendMessage: No text and no files, returning');
            return;
        }

        // If no session exists, create one now (lazy creation on first message)
        if (!currentSessionId) {
            createNewSession();
        }

        console.log('sendMessage: Starting with text:', text, 'files:', attachedFiles.length);

        // If files attached, upload them first
        if (attachedFiles.length > 0) {
            // Show uploading status
            const toast = document.getElementById('toast');
            if (toast) {
                toast.classList.remove('opacity-0', 'translate-y-4');
                document.getElementById('toast-message').textContent = `Uploading ${attachedFiles.length} files...`;
            }

            for (const file of attachedFiles) {
                try {
                    const formData = new FormData();
                    formData.append('file', file);
                    formData.append('session_id', currentSessionId); // Add session ID scope
                    const token = localStorage.getItem('access_token');
                    const headers = {};
                    if (token) {
                        headers['Authorization'] = `Bearer ${token}`;
                    }

                    await fetch('/api/upload', {
                        method: 'POST',
                        body: formData,
                        headers: headers
                    });
                } catch (e) {
                    console.error("Upload failed for", file.name);
                }
            }

            // Clear files
            attachedFiles = [];
            renderFileChips();
            if (toast) toast.classList.add('opacity-0', 'translate-y-4');
        }

        // Update session title and timestamp
        if (chatSessions[currentSessionId]) {
            if (chatSessions[currentSessionId].title === "New Chat" && text) {
                chatSessions[currentSessionId].title = text.substring(0, 30) + (text.length > 30 ? '...' : '');
            }
            chatSessions[currentSessionId].timestamp = Date.now();
            saveSessions();
            renderSessionList();
        }

        messageInput.value = '';
        messageInput.style.height = 'auto'; // Reset height
        toggleInputButtons();

        addMessage(text, true);

        // Create placeholder for AI response
        const aiMessageContent = addMessage("", false);

        // Show stop button, hide send button
        sendBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');

        // Create abort controller for this request
        abortController = new AbortController();

        try {
            const token = localStorage.getItem('access_token');
            const headers = {
                'Content-Type': 'application/json'
            };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const response = await fetch('/api/chat', {
                signal: abortController.signal,
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    message: text,
                    session_id: currentSessionId,
                    model: model
                })
            });

            if (response.status === 401 || response.status === 403) {
                aiMessageContent.textContent = "Error: Unauthorized. Please log in again.";
                // Optional: redirect to login
                return;
            }

            if (!response.ok) {
                aiMessageContent.textContent = "Error: Failed to get response.";
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            console.log('Starting to read stream...');
            let chunkCount = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    console.log('Stream done. Total chunks:', chunkCount);
                    break;
                }

                const chunk = decoder.decode(value, { stream: true });
                chunkCount++;
                console.log(`Chunk ${chunkCount}:`, chunk.substring(0, 50) + '...');
                aiMessageContent.textContent += chunk;
                scrollToBottom();
            }
            // Add TTS button after streaming is done (re-inject or ensure it's there)
            // It was added in addMessage, but textContent overwrite removes children.
            // We need to re-add TTS button.
            const ttsBtn = document.createElement('button');
            ttsBtn.className = "absolute -bottom-6 left-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity p-1 cursor-pointer";
            ttsBtn.innerHTML = '<i data-lucide="volume-2" class="w-4 h-4"></i>';
            ttsBtn.onclick = function () { speak(aiMessageContent.textContent, this); };
            aiMessageContent.appendChild(ttsBtn);
            lucide.createIcons();

        } catch (err) {
            // Handle abort gracefully
            if (err.name === 'AbortError') {
                aiMessageContent.textContent += "\n[Generation stopped]";
            } else {
                aiMessageContent.textContent += "\nNetwork Error: " + err.message;
            }
        } finally {
            // Reset buttons
            stopBtn.classList.add('hidden');
            toggleInputButtons(); // Ensure correct button state (Mic vs Send) based on input
            abortController = null;
        }
    }

    // --- Event Listeners ---
    themeToggle.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';

        // Optional: animate icon rotation or something?
        // simple toggle is fine.
    });

    micBtn.addEventListener('click', () => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    sendBtn.addEventListener('click', sendMessage);

    stopBtn.addEventListener('click', () => {
        if (abortController) {
            abortController.abort();
        }
    });

    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Auto-resize & Button Toggle
    messageInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        toggleInputButtons();
    });

    // File Upload (New Logic)
    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        // Add to state
        attachedFiles = [...attachedFiles, ...files];
        renderFileChips();
        fileInput.value = ''; // Reset input
        toggleInputButtons();
    });

    function renderFileChips() {
        fileChips.innerHTML = '';
        attachedFiles.forEach((file, index) => {
            const chip = document.createElement('div');
            chip.className = 'flex items-center gap-2 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-1.5 rounded-full text-sm animate-fadeIn';

            // Icon based on type
            let iconName = 'file';
            if (file.name.endsWith('.pdf')) iconName = 'file-text';
            if (file.name.endsWith('.docx')) iconName = 'file-type-2';

            const icon = document.createElement('i');
            icon.setAttribute('data-lucide', iconName);
            icon.className = 'w-4 h-4 text-blue-500';

            const name = document.createElement('span');
            name.className = 'max-w-[150px] truncate text-gray-700 dark:text-gray-300';
            name.textContent = file.name;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'ml-1 p-0.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 transition-colors';
            removeBtn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i>';
            removeBtn.onclick = () => {
                attachedFiles.splice(index, 1);
                renderFileChips();
                toggleInputButtons();
            };

            chip.append(icon, name, removeBtn);
            fileChips.appendChild(chip);
        });
        lucide.createIcons();
    }

    // --- Session Functions ---
    function saveSessions() {
        localStorage.setItem(storageKey, JSON.stringify(chatSessions));
        renderSessionList();
    }

    function createNewSession() {
        const sessionId = Date.now().toString();
        chatSessions[sessionId] = {
            id: sessionId,
            title: "New Chat",
            timestamp: Date.now()
        };
        saveSessions();
        currentSessionId = sessionId;
        localStorage.setItem(sessionIdKey, currentSessionId);
        loadSessionHistory(sessionId);
        renderSessionList();

        // Reset inputs
        if (messageInput) messageInput.value = '';
        if (fileChips) fileChips.innerHTML = '';
        attachedFiles = [];
        // update active state in sidebar handled by renderSessionList
    }

    async function loadSessionHistory(id) {
        currentSessionId = id;
        localStorage.setItem(sessionIdKey, id);

        // Clear current messages
        const container = chatContainer.querySelector('.max-w-5xl');
        container.innerHTML = '';

        // Fetch history
        try {
            const token = localStorage.getItem('access_token');
            const headers = {};
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const res = await fetch(`/api/history/${id}`, { headers });
            const data = await res.json();

            if (data.history && data.history.length > 0) {
                // Hide welcome
                const welcomeMsg = document.getElementById('welcome-message');
                if (welcomeMsg) welcomeMsg.classList.add('hidden');

                data.history.forEach(msg => {
                    addMessage(msg.content, msg.role === 'user');
                });
            } else {
                // Show welcome if empty ?
                // For now, simple logic
            }
        } catch (e) {
            console.error("Failed to load history", e);
        }

        renderSessionList();
        // Update active state in sidebar
    }

    function renderSessionList() {
        sessionList.innerHTML = '';
        const sortedSessions = Object.values(chatSessions).sort((a, b) => b.timestamp - a.timestamp);

        sortedSessions.forEach(session => {
            const btn = document.createElement('button');
            btn.className = `w-full text-left p-3 rounded-xl transition-all mb-1 flex items-center gap-3 ${session.id === currentSessionId ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-medium' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`;
            const date = new Date(session.timestamp || Date.now());
            const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

            btn.innerHTML = `
                <i data-lucide="message-square" class="w-4 h-4 shrink-0 text-gray-500"></i>
                <div class="flex-1 min-w-0">
                    <div class="truncate text-sm font-medium text-left">${session.title}</div>
                    <div class="text-xs text-gray-400 text-left">${dateStr}</div>
                </div>
            `;

            // Delete Button
            const delBtn = document.createElement('button');
            delBtn.className = 'p-1 hover:bg-red-100 dark:hover:bg-red-900/30 text-gray-400 hover:text-red-500 rounded-lg transition-colors opacity-0 group-hover:opacity-100';
            delBtn.innerHTML = '<i data-lucide="trash-2" class="w-3.5 h-3.5"></i>';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                showDeleteConfirmation(session.id, delBtn);
            };

            // Wrap content
            btn.appendChild(delBtn);
            btn.classList.add('group', 'justify-between'); // Add group class for hover effect

            btn.onclick = () => loadSessionHistory(session.id);
            sessionList.appendChild(btn);
        });
        lucide.createIcons();
    }

    let sessionToDelete = null;

    function showDeleteConfirmation(id, triggerElement) {
        sessionToDelete = id;
        const modal = document.getElementById('delete-confirmation-modal');
        const arrow = document.getElementById('modal-arrow');

        // Position modal
        const rect = triggerElement.getBoundingClientRect();
        const modalWidth = 256; // w-64 = 16rem = 256px

        // Calculate position (right side of sidebar usually)
        let top = rect.top - 20;
        let left = rect.right + 10;

        // Adjust if out of bounds (simple check)
        if (left + modalWidth > window.innerWidth) {
            left = rect.left - modalWidth - 10; // Show on left if no space on right
            arrow.className = "absolute w-3 h-3 bg-white dark:bg-gray-800 border-r border-t border-gray-200 dark:border-gray-700 transform rotate-45 -right-1.5 top-6";
        } else {
            arrow.className = "absolute w-3 h-3 bg-white dark:bg-gray-800 border-l border-b border-gray-200 dark:border-gray-700 transform rotate-45 -left-1.5 top-6";
        }

        modal.style.top = `${top}px`;
        modal.style.left = `${left}px`;

        modal.classList.remove('hidden');

        // Close on click outside
        const closeHandler = (e) => {
            if (!modal.contains(e.target) && !triggerElement.contains(e.target)) {
                hideDeleteConfirmation();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    function hideDeleteConfirmation() {
        const modal = document.getElementById('delete-confirmation-modal');
        modal.classList.add('hidden');
        sessionToDelete = null;
    }

    // Modal Buttons
    document.getElementById('cancel-delete-btn').addEventListener('click', hideDeleteConfirmation);
    document.getElementById('confirm-delete-btn').addEventListener('click', () => {
        if (sessionToDelete) {
            performDeleteSession(sessionToDelete);
            hideDeleteConfirmation();
        }
    });

    async function performDeleteSession(id) {
        // Optimistic UI update
        delete chatSessions[id];
        saveSessions();

        // Backend delete
        try {
            const token = localStorage.getItem('access_token');
            const headers = {};
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            await fetch(`/api/history/${id}`, { method: 'DELETE', headers });
        } catch (e) {
            console.error("Failed to delete session on backend", e);
        }

        // If current session deleted, create new
        if (currentSessionId === id || !currentSessionId) {
            createNewSession();
        }
    }

    // Sidebar Events
    newChatBtn.addEventListener('click', createNewSession);

    // Sidebar Events


    // Mobile Sidebar
    const mobileTrigger = document.getElementById('mobileSidebarTrigger');
    if (mobileTrigger) {
        mobileTrigger.addEventListener('click', () => {
            historySidebar.classList.remove('-translate-x-full');
            // Ensure proper stacking/display on mobile
        });
    }

    // Existing sidebar toggle (maybe used for mobile closing or other specific logic)
    // The previous sidebarButtons might need cleanup.
    // We added #desktopSidebarToggle

    const desktopSidebarToggle = document.getElementById('desktopSidebarToggle');
    const bookmarkToggle = document.getElementById('sidebarToggle'); // Mobile bookmark toggle 

    // Function to toggle sidebar
    function toggleSidebar() {
        // Toggle negative margin for desktop hiding
        historySidebar.classList.toggle('md:-ml-72'); // w-72 is 18rem

        // Also handle mobile transform if needed, but this is mainly for desktop "hide/show" request
        // Verify visual state
        const isClosed = historySidebar.classList.contains('md:-ml-72');

        // Rotate arrow
        const icon = desktopSidebarToggle.querySelector('i');
        if (isClosed) {
            icon.style.transform = 'rotate(180deg)';
        } else {
            icon.style.transform = 'rotate(0deg)';
        }
    }

    if (desktopSidebarToggle) {
        desktopSidebarToggle.addEventListener('click', toggleSidebar);
    }

    // Mobile Bookmark Toggle (close/open)
    if (bookmarkToggle) {
        bookmarkToggle.addEventListener('click', () => {
            // For mobile, we manipulate translate-x
            if (historySidebar.classList.contains('-translate-x-full')) {
                historySidebar.classList.remove('-translate-x-full');
            } else {
                historySidebar.classList.add('-translate-x-full');
            }
        });
    }

    // Close sidebar button (x) inside sidebar
    if (closeSidebar) {
        closeSidebar.addEventListener('click', () => {
            historySidebar.classList.add('-translate-x-full');
        });
    }





    // Initial toggle check
    toggleInputButtons();
    // --- Admin Dashboard Logic ---
    const adminModal = document.getElementById('adminModal');
    const adminModalBtn = document.getElementById('adminModalBtn');
    // userRole and currentUser already defined at top scope

    // Show Admin Button if authorized
    if (userRole === 'admin' || userRole === 'superadmin') {
        if (adminModalBtn) {
            adminModalBtn.classList.remove('hidden');
            adminModalBtn.addEventListener('click', () => {
                toggleAdminModal(true);
                // Default to Ingestion tab
                switchAdminTab('ingestion');
            });
        }

        // Show Users Tab for Admins and Superadmins
        const userTab = document.getElementById('tab-users');
        if (userTab) userTab.classList.remove('hidden');
    }

    window.toggleAdminModal = function (show) {
        if (show) {
            adminModal.classList.remove('hidden');
            fetchDocuments();
            if (userRole === 'admin' || userRole === 'superadmin') {
                fetchUsers();
            }
        } else {
            adminModal.classList.add('hidden');
        }
    };

    // --- Document Management ---

    // Admin Tab Switching
    window.switchAdminTab = function (tabName) {
        // 1. Hide all content
        ['ingestion', 'documents', 'users'].forEach(t => {
            const content = document.getElementById(`content-${t}`);
            const btn = document.getElementById(`tab-${t}`);
            if (content) content.classList.add('hidden');
            if (btn) {
                btn.classList.remove('border-blue-500', 'text-blue-600', 'dark:text-blue-400');
                btn.classList.add('border-transparent', 'text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300', 'dark:text-gray-400');
            }
        });

        // 2. Show selected
        const activeContent = document.getElementById(`content-${tabName}`);
        const activeBtn = document.getElementById(`tab-${tabName}`);

        if (activeContent) activeContent.classList.remove('hidden');
        if (activeBtn) {
            activeBtn.classList.remove('border-transparent', 'text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300', 'dark:text-gray-400');
            activeBtn.classList.add('border-blue-500', 'text-blue-600', 'dark:text-blue-400');
        }

        // Fetch Data on Tab Switch
        if (tabName === 'users') {
            fetchUsers();
        } else if (tabName === 'documents') {
            fetchDocuments();
        }
    }

    // Ingestion Logic
    const ingestForm = document.getElementById('ingestForm');
    const chunkSizeSlider = document.getElementById('chunkSize');
    const overlapSlider = document.getElementById('overlap');
    const ingestDropZone = document.getElementById('ingestDropZone');
    const ingestFileInput = document.getElementById('ingestFile');
    const ingestFileNameDisplay = document.getElementById('ingestFileName');

    let selectedFiles = [];

    function updateFileList() {
        if (!ingestFileNameDisplay) return;
        ingestFileNameDisplay.innerHTML = '';
        if (selectedFiles.length === 0) {
            ingestFileNameDisplay.textContent = '';
            return;
        }
        selectedFiles.forEach((file, index) => {
            const div = document.createElement('div');
            div.className = "flex justify-between items-center text-xs bg-blue-50 dark:bg-blue-900/30 p-1 rounded px-2 mb-1";
            div.innerHTML = `
                <span class="truncate flex-1 text-left mr-2 min-w-0">${file.name}</span>
                <button type="button" class="text-red-500 hover:text-red-700 shrink-0" onclick="removeFile(${index})" title="Remove">
                    <i data-lucide="x" class="w-3 h-3"></i>
                </button>
            `;
            ingestFileNameDisplay.appendChild(div);
        });
        lucide.createIcons();
    }

    window.removeFile = function (index) {
        selectedFiles.splice(index, 1);
        updateFileList();
        // Reset input so same file can be selected again if needed
        if (ingestFileInput) ingestFileInput.value = '';
    }

    if (chunkSizeSlider && overlapSlider) { // Config Sliders
        const chunkSizeVal = document.getElementById('chunkSizeVal');
        const overlapVal = document.getElementById('overlapVal');
        chunkSizeSlider.addEventListener('input', (e) => chunkSizeVal.textContent = e.target.value);
        overlapSlider.addEventListener('input', (e) => overlapVal.textContent = e.target.value);
    }

    if (ingestForm) {
        // Drag and Drop
        if (ingestDropZone) {
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                ingestDropZone.addEventListener(eventName, preventDefaults, false);
            });

            function preventDefaults(e) {
                e.preventDefault();
                e.stopPropagation();
            }

            ['dragenter', 'dragover'].forEach(eventName => {
                ingestDropZone.addEventListener(eventName, highlight, false);
            });

            ['dragleave', 'drop'].forEach(eventName => {
                ingestDropZone.addEventListener(eventName, unhighlight, false);
            });

            function highlight(e) {
                ingestDropZone.classList.add('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
            }

            function unhighlight(e) {
                ingestDropZone.classList.remove('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
            }

            ingestDropZone.addEventListener('drop', handleDrop, false);

            function handleDrop(e) {
                const dt = e.dataTransfer;
                const files = dt.files;
                handleFiles(files);
            }
        }

        if (ingestFileInput) {
            ingestFileInput.addEventListener('change', function (e) {
                handleFiles(this.files);
            });
            // Stop click propagation from dropzone to input to avoid double dialog
            ingestFileInput.addEventListener('click', (e) => e.stopPropagation());
        }

        function handleFiles(files) {
            // Append new files to existing list
            if (files.length > 0) {
                selectedFiles = [...selectedFiles, ...Array.from(files)];
                updateFileList();
            }
        }

        ingestForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            if (selectedFiles.length === 0) return alert("Select at least one file");

            const btn = e.target.querySelector('button[type="submit"]');
            const statusDiv = document.getElementById('ingestStatus');
            btn.disabled = true;
            statusDiv.innerHTML = '';
            statusDiv.className = 'text-center text-sm font-medium';

            let successCount = 0;
            let errorCount = 0;
            let totalChunks = 0;
            const errors = [];

            try {
                // To avoid blocking the UI, we'll iterate with a small delay if needed, 
                // but standard await fetch is fine.
                for (let i = 0; i < selectedFiles.length; i++) {
                    const file = selectedFiles[i];
                    const progress = Math.round(((i) / selectedFiles.length) * 100);

                    statusDiv.innerHTML = `
                        <div class="mb-2 w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700 overflow-hidden">
                            <div class="bg-blue-600 h-2.5 rounded-full transition-all duration-300" style="width: ${progress}%"></div>
                        </div>
                        <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">Total Progress: ${progress}%</div>
                        <div class="animate-pulse">
                            Processing file ${i + 1} of ${selectedFiles.length}: <span class="font-semibold text-blue-600">${file.name}</span>
                        </div>
                    `;

                    const formData = new FormData();
                    formData.append('files', file);
                    if (chunkSizeSlider) formData.append('chunk_size', chunkSizeSlider.value);
                    if (overlapSlider) formData.append('chunk_overlap', overlapSlider.value);

                    try {
                        const res = await fetch('/api/ingest', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` },
                            body: formData
                        });
                        const data = await res.json();

                        if (!res.ok) throw new Error(data.detail || 'Ingestion failed');

                        if (data.errors && data.errors.length > 0) {
                            errorCount++;
                            errors.push(...data.errors);
                        } else {
                            successCount++;
                            totalChunks += data.total_chunks;
                        }

                    } catch (err) {
                        errorCount++;
                        errors.push(`${file.name}: ${err.message}`);
                        console.error(`Failed to ingest ${file.name}`, err);
                    }
                }

                // Final Status
                statusDiv.innerHTML = '';
                if (errorCount > 0) {
                    statusDiv.textContent = `Completed with issues. Success: ${successCount}, Errors: ${errorCount}`;
                    statusDiv.className = 'text-center text-sm font-medium text-orange-600';
                    if (errors.length > 0) console.error("Ingestion Errors:", errors);
                } else {
                    statusDiv.textContent = `All Done! ${totalChunks} chunks added from ${successCount} files.`;
                    statusDiv.className = 'text-center text-sm font-medium text-green-600';
                }

                selectedFiles = [];
                updateFileList();
                fetchDocuments();

            } catch (err) {
                statusDiv.textContent = `Critical Error: ${err.message}`;
                statusDiv.className = 'text-center text-sm font-medium text-red-600';
            } finally {
                btn.disabled = false;
            }
        });
    }

    const refreshDocsBtn = document.getElementById('refreshDocsBtn');
    if (refreshDocsBtn) refreshDocsBtn.addEventListener('click', fetchDocuments);

    async function fetchDocuments() {
        try {
            const res = await fetch('/api/documents', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` }
            });
            const data = await res.json();
            renderDocuments(data.documents);
        } catch (err) {
            console.error("Failed to load documents", err);
        }
    }

    function renderDocuments(docs) {
        const tbody = document.getElementById('docTableBody');
        if (!tbody) return;
        tbody.innerHTML = '';
        docs.forEach(doc => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">${doc.id}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer" 
                    onclick="viewChunks(${doc.id})">
                    ${doc.filename}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                    S: ${doc.chunk_size}, O: ${doc.chunk_overlap}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                    ${new Date(doc.upload_timestamp).toLocaleDateString()}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <button onclick="deleteDocument(${doc.id})" class="text-white bg-red-600 hover:bg-red-700 px-3 py-1 rounded-lg text-xs transition-colors shadow-sm">
                        <i data-lucide="trash-2" class="w-4 h-4 inline mr-1"></i>Delete
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        lucide.createIcons();
    }

    window.deleteDocument = async function (docId) {
        if (!confirm("Are you sure you want to delete this document and all its chunks?")) return;
        try {
            const res = await fetch(`/api/documents/${docId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` }
            });
            if (res.ok) {
                fetchDocuments();
            } else {
                alert("Failed to delete document");
            }
        } catch (e) {
            alert("Error deleting document: " + e.message);
        }
    };

    window.viewChunks = async function (docId) {
        const modal = document.getElementById('chunkModal');
        const container = document.getElementById('chunkContainer');
        const title = document.getElementById('chunkModalTitle');

        container.innerHTML = '<div class="text-center p-4">Loading chunks...</div>';
        modal.classList.remove('hidden');

        try {
            const res = await fetch(`/api/documents/${docId}/chunks`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` }
            });
            const data = await res.json();

            title.textContent = `Chunks: ${data.filename}`;
            container.innerHTML = '';

            if (data.chunks.length === 0) {
                container.innerHTML = '<div class="text-center p-4 text-gray-500">No chunks found.</div>';
                return;
            }

            data.chunks.forEach((chunk, idx) => {
                const el = document.createElement('div');
                el.className = "bg-gray-50 dark:bg-gray-900 p-4 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-mono whitespace-pre-wrap text-gray-700 dark:text-gray-300";
                el.innerHTML = `
                    <div class="text-xs text-blue-500 font-bold mb-2">Chunk #${idx + 1}</div>
                    ${chunk.content}
                `;
                container.appendChild(el);
            });
        } catch (e) {
            container.innerHTML = `<div class="text-red-500 p-4">Error loading chunks: ${e.message}</div>`;
        }
    };

    window.closeChunkModal = function () {
        document.getElementById('chunkModal').classList.add('hidden');
    };

    // --- User Management ---
    const refreshUsersBtn = document.getElementById('refreshUsersBtn');
    if (refreshUsersBtn) refreshUsersBtn.addEventListener('click', fetchUsers);

    async function fetchUsers() {
        try {
            const res = await fetch('/api/users', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` }
            });
            if (!res.ok) throw new Error('Failed to fetch users');
            const data = await res.json();
            renderUsers(data.users);
        } catch (err) {
            console.error(err);
            const status = document.getElementById('userStatus');
            if (status) status.textContent = "Failed to load users.";
        }
    }

    // Add User Logic
    const addUserFormContainer = document.getElementById('addUserFormContainer');
    const addUserForm = document.getElementById('addUserForm');

    window.openAddUserModal = function () {
        if (addUserFormContainer) addUserFormContainer.classList.remove('hidden');
    }

    window.closeAddUserModal = function () {
        if (addUserFormContainer) addUserFormContainer.classList.add('hidden');
        if (addUserForm) addUserForm.reset();
    }

    if (addUserForm) {
        addUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('newUsername').value;
            const password = document.getElementById('newPassword').value;
            const role = document.getElementById('newRole').value;

            try {
                const formData = new FormData();
                formData.append('username', username);
                formData.append('password', password);
                formData.append('role', role);

                const res = await fetch('/api/users', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` },
                    body: formData
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || 'Failed to create user');

                alert(`User ${data.username} created successfully!`);
                closeAddUserModal();
                fetchUsers(); // Refresh list
            } catch (err) {
                alert(err.message);
            }
        });
    }

    function renderUsers(users) {
        const tbody = document.getElementById('userTableBody');
        if (!tbody) return;
        tbody.innerHTML = '';

        users.forEach(user => {
            const tr = document.createElement('tr');
            let actionsHtml = '';
            const isSelf = user.username === currentUser;

            if (!isSelf) {
                if (userRole === 'superadmin') {
                    if (user.role === 'user') {
                        actionsHtml += `<button onclick="updateRole(${user.id}, 'admin')" class="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-2 py-1 rounded hover:bg-purple-200 dark:hover:bg-purple-900/50 mr-2">Make Admin</button>`;
                    } else if (user.role === 'admin') {
                        actionsHtml += `<button onclick="updateRole(${user.id}, 'user')" class="text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 mr-2">Revoke Admin</button>`;
                    }
                } else if (userRole === 'admin') {
                    if (user.role === 'user') {
                        actionsHtml += `<button onclick="updateRole(${user.id}, 'admin')" class="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-2 py-1 rounded hover:bg-purple-200 dark:hover:bg-purple-900/50 mr-2">Make Admin</button>`;
                    } else if (user.role === 'admin') {
                        actionsHtml += `<button onclick="updateRole(${user.id}, 'user')" class="text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 mr-2">Revoke Admin</button>`;
                    }
                }
            }

            tr.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">${user.id}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-white">${user.username}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                    <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full 
                        ${user.role === 'superadmin' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' :
                    user.role === 'admin' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300' : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'}">
                        ${user.role}
                    </span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    ${actionsHtml}
                </td>
            `;
            tbody.appendChild(tr);
        });
        lucide.createIcons();
    }

    window.updateRole = async function (userId, newRole) {
        if (!confirm(`Are you sure you want to change this user's role to ${newRole}?`)) return;

        try {
            const res = await fetch(`/api/users/${userId}/role`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ role: newRole })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Failed to update role');

            fetchUsers();
            const status = document.getElementById('userStatus');
            if (status) {
                status.textContent = `User ${data.username} updated to ${data.role}!`;
                status.className = "text-center text-sm font-medium mt-4 text-green-600";
                setTimeout(() => { status.textContent = ''; }, 3000);
            }

        } catch (err) {
            alert(err.message);
        }
    };


    // --- User Profile & Logout ---
    const currentUserDisplay = document.getElementById('currentUserDisplay');
    const currentUserRole = document.getElementById('currentUserRole');
    const userAvatarInitial = document.getElementById('userAvatarInitial');
    const logoutBtn = document.getElementById('logoutBtn');

    if (currentUser && currentUserDisplay) {
        currentUserDisplay.textContent = currentUser;
        userAvatarInitial.textContent = currentUser.charAt(0).toUpperCase();
        if (currentUserRole && userRole) {
            currentUserRole.textContent = userRole;
        }
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (confirm("Sign out?")) {
                localStorage.removeItem('access_token');
                localStorage.removeItem('username');
                localStorage.removeItem('user_role');
                // Clear user-specific session ID
                if (currentUser) {
                    localStorage.removeItem(`current_session_id_${currentUser}`);
                }
                window.location.href = 'index.html';
            }
        });
    }

});
