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
    let chatSessions = JSON.parse(localStorage.getItem('chat_sessions') || '{}');
    let abortController = null; // For stopping generation


    // Theme (keep existing logic)
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    // Session (New Logic)
    let currentSessionId = localStorage.getItem('current_session_id');

    // Sidebar Elements
    const historySidebar = document.getElementById('historySidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const closeSidebar = document.getElementById('closeSidebar');
    const sessionList = document.getElementById('sessionList');
    const newChatBtn = document.getElementById('newChatBtn');
    const fileChips = document.getElementById('fileChips');

    if (!currentSessionId) {
        createNewSession();
    } else {
        // Ensure session exists in list (migration)
        if (!chatSessions[currentSessionId]) {
            chatSessions[currentSessionId] = { id: currentSessionId, title: "New Chat", timestamp: Date.now() };
            saveSessions();
        }
        loadSessionHistory(currentSessionId);
    }
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
    function speak(text) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'id-ID';
        // utterance.rate = 1.1;
        window.speechSynthesis.speak(utterance);
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
            ttsBtn.onclick = () => speak(content.textContent);
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
                    await fetch('/api/upload', { method: 'POST', body: formData });
                } catch (e) {
                    console.error("Upload failed for", file.name);
                }
            }

            // Clear files
            attachedFiles = [];
            renderFileChips();
            if (toast) toast.classList.add('opacity-0', 'translate-y-4');
        }

        // Update session title if it's "New Chat"
        if (chatSessions[currentSessionId] && chatSessions[currentSessionId].title === "New Chat" && text) {
            chatSessions[currentSessionId].title = text.substring(0, 30) + (text.length > 30 ? '...' : '');
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
            const response = await fetch('/api/chat', {
                signal: abortController.signal,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: text,
                    session_id: currentSessionId,
                    model: model
                })
            });

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
            ttsBtn.onclick = () => speak(aiMessageContent.textContent);
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
        localStorage.setItem('chat_sessions', JSON.stringify(chatSessions));
        renderSessionList();
    }

    function createNewSession() {
        const id = crypto.randomUUID();
        const session = {
            id: id,
            title: "New Chat",
            timestamp: Date.now()
        };
        chatSessions[id] = session;
        currentSessionId = id;
        localStorage.setItem('current_session_id', id);

        // Clear UI
        chatContainer.querySelector('.max-w-5xl').innerHTML = '';
        saveSessions();

        // Show welcome only for new chat
        // (Simplified: just clear messages, existing welcome msg logic might need tweak but it's hidden by CSS usually if messages exist)
        // Actually, we should restore Welcome message if empty.
        // For now, let's just reload page or handle it purely UI
    }

    async function loadSessionHistory(id) {
        currentSessionId = id;
        localStorage.setItem('current_session_id', id);

        // Clear current messages
        const container = chatContainer.querySelector('.max-w-5xl');
        container.innerHTML = '';

        // Fetch history
        try {
            const res = await fetch(`/api/history/${id}`);
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
            btn.innerHTML = `
                <i data-lucide="message-square" class="w-4 h-4 shrink-0"></i>
                <span class="truncate text-sm flex-1 text-left">${session.title}</span>
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
            await fetch(`/api/history/${id}`, { method: 'DELETE' });
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
    const userRole = localStorage.getItem('user_role');

    // Show Admin Button if authorized
    if (userRole === 'admin' || userRole === 'superadmin') {
        if (adminModalBtn) {
            adminModalBtn.classList.remove('hidden');
            adminModalBtn.addEventListener('click', () => toggleAdminModal(true));
        }

        // Show Superadmin specific section
        if (userRole === 'superadmin') {
            const adminMgmt = document.getElementById('adminManagement');
            if (adminMgmt) adminMgmt.classList.remove('hidden');
        }
    }

    window.toggleAdminModal = function (show) {
        if (show) {
            adminModal.classList.remove('hidden');
        } else {
            adminModal.classList.add('hidden');
        }
    };

    // Ingestion Logic
    const ingestForm = document.getElementById('ingestForm');
    if (ingestForm) {
        document.getElementById('ingestFile').addEventListener('change', (e) => {
            if (e.target.files[0]) document.getElementById('ingestFileName').textContent = e.target.files[0].name;
        });

        ingestForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const file = document.getElementById('ingestFile').files[0];
            if (!file) return alert("Select a file");

            const btn = e.target.querySelector('button');
            const statusDiv = document.getElementById('ingestStatus');
            btn.disabled = true;
            statusDiv.textContent = "Uploading & Ingesting...";
            statusDiv.className = 'text-center text-sm font-medium'; // Reset class

            const formData = new FormData();
            formData.append('file', file);

            try {
                const res = await fetch('/api/ingest', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${localStorage.getItem('access_token')}`
                    },
                    body: formData
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || 'Ingestion failed');

                statusDiv.textContent = `Success! ${data.chunks} chunks added to Base Knowledge.`;
                statusDiv.classList.add('text-green-600');
            } catch (err) {
                statusDiv.textContent = `Error: ${err.message}`;
                statusDiv.classList.add('text-red-600');
            } finally {
                btn.disabled = false;
            }
        });
    }

    // Add Admin Logic
    const addAdminForm = document.getElementById('addAdminForm');
    if (addAdminForm) {
        addAdminForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData();
            formData.append('username', document.getElementById('newAdminUser').value);
            formData.append('password', document.getElementById('newAdminPass').value);

            try {
                const res = await fetch('/api/auth/register-admin', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${localStorage.getItem('access_token')}`
                    },
                    body: formData
                });
                if (!res.ok) throw new Error('Failed to add admin');

                const status = document.getElementById('adminStatus');
                status.textContent = "Admin added successfully!";
                status.className = "text-center text-sm font-medium text-green-600";
                document.getElementById('newAdminUser').value = '';
                document.getElementById('newAdminPass').value = '';
            } catch (err) {
                const status = document.getElementById('adminStatus');
                status.textContent = err.message;
                status.className = "text-center text-sm font-medium text-red-600";
            }
        });
    }


});
