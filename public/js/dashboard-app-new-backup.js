        console.log('🔧 Initializing dashboard page...');
        
        // Authentication check - GLOBAL authToken variable
        let authToken = localStorage.getItem('authToken');
        if (!authToken) {
            console.log('⚠️ No auth token found, redirecting to login');
            window.location.href = '/login';
        } else {
            console.log('✅ Auth token found');
        }

        // Load user info
        let userData = JSON.parse(localStorage.getItem('userData') || '{}');
        console.log('👤 User data loaded:', userData);

        // File storage
        let resumeFile = null;
        let photoFile = null;
        let signatureFile = null;

        // Recipients management
        let recipientCount = 1;

        function addRecipient() {
            const recipientList = document.getElementById('recipientList');
            const newRecipient = document.createElement('div');
            newRecipient.className = 'recipient-row';
            newRecipient.setAttribute('data-index', recipientCount);
            
            newRecipient.innerHTML = `
                <div class="recipient-header">
                    <div class="recipient-number">${recipientCount + 1}</div>
                    <button class="remove-btn" onclick="removeRecipient(${recipientCount})">
                        × Remove
                    </button>
                </div>
                <div class="form-group">
                    <label class="form-label">Hiring Manager's Email <span class="required">*</span></label>
                    <input 
                        type="email" 
                        class="form-input" 
                        placeholder="hiring@company.com"
                        name="email"
                        required
                    >
                </div>
                <div class="form-group">
                    <label class="form-label">Company Website <span class="required">*</span></label>
                    <input 
                        type="url" 
                        class="form-input" 
                        placeholder="https://www.company.com"
                        name="website"
                        required
                    >
                </div>
                <div class="form-group">
                    <label class="form-label">Position/Job Title</label>
                    <input 
                        type="text" 
                        class="form-input" 
                        placeholder="Software Engineer, Marketing Manager, etc."
                        name="position"
                    >
                </div>
            `;
            
            recipientList.appendChild(newRecipient);
            recipientCount++;
            
            // Update first recipient's remove button visibility
            updateRemoveButtons();
        }

        function removeRecipient(index) {
            const recipient = document.querySelector(`[data-index="${index}"]`);
            if (recipient) {
                recipient.remove();
                // Renumber remaining recipients
                renumberRecipients();
                updateRemoveButtons();
            }
        }

        function renumberRecipients() {
            const recipients = document.querySelectorAll('.recipient-row');
            recipients.forEach((recipient, index) => {
                const number = recipient.querySelector('.recipient-number');
                if (number) {
                    number.textContent = index + 1;
                }
                recipient.setAttribute('data-index', index);
                
                // Update remove button onclick
                const removeBtn = recipient.querySelector('.remove-btn');
                if (removeBtn) {
                    removeBtn.setAttribute('onclick', `removeRecipient(${index})`);
                }
            });
            recipientCount = recipients.length;
        }

        function updateRemoveButtons() {
            const recipients = document.querySelectorAll('.recipient-row');
            recipients.forEach((recipient, index) => {
                const removeBtn = recipient.querySelector('.remove-btn');
                if (removeBtn) {
                    removeBtn.style.display = recipients.length > 1 ? 'flex' : 'none';
                }
            });
        }

        // Restore form values from backend API
        async function restoreFormValues() {
            const userData = JSON.parse(localStorage.getItem('userData') || '{}');
            if (!userData.email) return;
            
            try {
                // Load recipients from backend API
                const response = await fetch('/api/users/recipients', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    
                    if (data.success && data.recipients && data.recipients.length > 0) {
                        console.log(`✅ Loaded ${data.recipients.length} recipients from backend`);
                        
                        // Add recipient items if needed
                        while (document.querySelectorAll('.recipient-row').length < data.recipients.length) {
                            addRecipient();
                        }
                        
                        // Fill in the values
                        const items = document.querySelectorAll('.recipient-row');
                        data.recipients.forEach((recipient, index) => {
                            if (items[index]) {
                                items[index].querySelector('input[name="email"]').value = recipient.email || '';
                                items[index].querySelector('input[name="website"]').value = recipient.website || '';
                                items[index].querySelector('input[name="position"]').value = recipient.position || '';
                            }
                        });
                        
                        console.log('✅ Form values restored from backend API');
                    } else {
                        console.log('ℹ️ No stored recipients found');
                    }
                } else {
                    console.log('⚠️ Failed to load recipients from backend');
                }
            } catch (error) {
                console.error('❌ Error loading recipients:', error);
            }
        }

        // Auto-save recipients function (debounced) - save to backend API
        let saveTimer;
        function autoSaveRecipients() {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(async () => {
                if (!authToken) return;
                
                const recipients = [];
                const recipientItems = document.querySelectorAll('.recipient-row');
                
                recipientItems.forEach(item => {
                    const email = item.querySelector('input[name="email"]').value.trim();
                    const website = item.querySelector('input[name="website"]').value.trim();
                    const position = item.querySelector('input[name="position"]').value.trim();
                    
                    if (email || website) {
                        recipients.push({ email, website, position });
                    }
                });
                
                if (recipients.length > 0) {
                    try {
                        const response = await fetch('/api/users/recipients', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${authToken}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ recipients })
                        });

                        if (response.ok) {
                            const data = await response.json();
                            console.log(`✅ Auto-saved ${data.recipientsCount} recipients to backend`);
                        } else {
                            console.log('⚠️ Failed to auto-save recipients');
                        }
                    } catch (error) {
                        console.error('❌ Error auto-saving recipients:', error);
                    }
                }
            }, 2000); // 2 second debounce
        }

        // Add event listeners for auto-save
        document.addEventListener('input', (e) => {
            if (e.target.closest('.recipient-row')) {
                autoSaveRecipients();
            }
        });

        function reviewAndSend() {
            console.log('🚀 Review and Send clicked');
            
            // Collect recipient data
            const recipients = [];
            const recipientItems = document.querySelectorAll('.recipient-row');
            
            let hasError = false;
            recipientItems.forEach(item => {
                const email = item.querySelector('input[name="email"]').value.trim();
                const website = item.querySelector('input[name="website"]').value.trim();
                const position = item.querySelector('input[name="position"]').value.trim();
                
                if (!email || !website) {
                    hasError = true;
                    return;
                }
                
                recipients.push({ email, website, position });
            });
            
            if (hasError) {
                showToast('Please fill in all required fields (Email and Website)', 'error');
                return;
            }
            
            if (recipients.length === 0) {
                showToast('Please add at least one recipient', 'error');
                return;
            }
            
            console.log('✅ Collected recipients:', recipients.length);
            
            // Store recipients and redirect to review page
            localStorage.setItem('pendingRecipients', JSON.stringify(recipients));
            console.log('✅ Stored recipients in localStorage');
            window.location.href = '/review';
        }

        // Modal functions
        function closeSettings() {
            document.getElementById('settingsModal').classList.remove('active');
        }

        function closeProfile() {
            document.getElementById('profileModal').classList.remove('active');
        }

        async function saveSettings() {
            const email = document.getElementById('smtpEmail').value.trim();
            const password = document.getElementById('smtpPassword').value.trim();
            const name = document.getElementById('senderName').value.trim();
            
            if (!email || !password || !name) {
                showToast('Please fill in all fields', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/smtp/config', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ email, password, name }),
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    showToast('Settings saved successfully!', 'success');
                    closeSettings();
                } else {
                    showToast(result.error || 'Failed to save settings', 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                showToast('Failed to save settings. Please try again.', 'error');
            }
        }

        // File upload handlers
        

        

        

        function removeFile(type) {
            if (type === 'resume') {
                resumeFile = null;
                document.getElementById('resumeFileInfo').classList.remove('active');
                document.getElementById('resumeUpload').classList.remove('has-file');
                document.getElementById('resumeInput').value = '';
            } else if (type === 'photo') {
                photoFile = null;
                document.getElementById('photoUpload').classList.remove('has-file', 'has-preview');
                document.getElementById('photoInput').value = '';
                document.getElementById('photoPreview').classList.remove('active');
                document.getElementById('photoUploadContent').classList.remove('hidden');
                document.getElementById('photoPreviewImg').src = '';
            } else if (type === 'signature') {
                signatureFile = null;
                document.getElementById('signatureUpload').classList.remove('has-file', 'has-preview');
                document.getElementById('signatureInput').value = '';
                document.getElementById('signaturePreview').classList.remove('active');
                document.getElementById('signatureUploadContent').classList.remove('hidden');
                document.getElementById('signaturePreviewImg').src = '';
            }
        }

        async function saveProfile() {
            const formData = new FormData();
            
            const rInput = document.getElementById('resumeInput').files[0];
            const pInput = document.getElementById('photoInput').files[0];
            const sInput = document.getElementById('signatureInput').files[0];
            
            if (rInput) formData.append('resume', rInput);
            if (pInput) formData.append('photo', pInput);
            if (sInput) formData.append('signature', sInput);

            if (!rInput && !pInput && !sInput) {
                showToast('No new files selected. Settings saved.', 'success');
                document.getElementById('profileModal').classList.remove('open');
                return;
            }

            try {
                const response = await fetch('/api/upload-profile', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${authToken}`
                    },
                    body: formData,
                });

                const result = await response.json();

                if (response.ok) {
                    showToast('Profile updated successfully!', 'success');
                    
                    resumeFile = null;
                    photoFile = null;
                    signatureFile = null;
                    
                    document.getElementById('resumeInput').value = '';
                    document.getElementById('photoInput').value = '';
                    document.getElementById('signatureInput').value = '';
                    
                    await loadProfile();
                    closeProfile();
                } else {
                    showToast(result.error || 'Failed to upload files', 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                showToast('Failed to upload files. Please try again.', 'error');
            }
        }

        async function loadProfile() {
            try {
                const token = localStorage.getItem('authToken');
                const response = await fetch('/api/user-profile', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    }
                });

                if (response.ok) {
                    const result = await response.json();
                    const profile = result.profile;
                    
                    if (profile.resumePath) {
                        const fileName = profile.resumePath.split('/').pop();
                        const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                        
                        document.getElementById('resumeName').textContent = fileName;
                        document.getElementById('resumeDate').textContent = `Uploaded: ${date}`;
                        document.getElementById('resumeFileInfo').classList.add('active');
                        document.getElementById('resumeUpload').classList.add('has-file');
                        
                        const resumePath = profile.resumePath.replace('uploads/', '/uploads/');
                        document.getElementById('resumeDownload').href = resumePath;
                        document.getElementById('resumeDownload').download = fileName;
                    }
                    
                    if (profile.photoPath) {
                        const photoPath = profile.photoPath.replace('uploads/', '/uploads/');
                        
                        const imageResponse = await fetch(photoPath, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        
                        if (imageResponse.ok) {
                            const blob = await imageResponse.blob();
                            const dataUrl = await blobToDataURL(blob);
                            
                            const photoPreview = document.getElementById('photoPreview');
                            const photoPreviewImg = document.getElementById('photoPreviewImg');
                            const photoUploadContent = document.getElementById('photoUploadContent');
                            const photoUploadArea = document.getElementById('photoUpload');
                            
                            photoPreviewImg.src = dataUrl;
                            photoUploadContent.classList.add('hidden');
                            photoPreview.classList.add('active');
                            photoUploadArea.classList.add('has-file', 'has-preview');
                        }
                    }
                    
                    if (profile.signaturePath) {
                        const signaturePath = profile.signaturePath.replace('uploads/', '/uploads/');
                        
                        const imageResponse = await fetch(signaturePath, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        
                        if (imageResponse.ok) {
                            const blob = await imageResponse.blob();
                            const dataUrl = await blobToDataURL(blob);
                            
                            const signaturePreview = document.getElementById('signaturePreview');
                            const signaturePreviewImg = document.getElementById('signaturePreviewImg');
                            const signatureUploadContent = document.getElementById('signatureUploadContent');
                            const signatureUploadArea = document.getElementById('signatureUpload');
                            
                            signaturePreviewImg.src = dataUrl;
                            signatureUploadContent.classList.add('hidden');
                            signaturePreview.classList.add('active');
                            signatureUploadArea.classList.add('has-file', 'has-preview');
                        }
                    }
                }
            } catch (error) {
                console.error('Error loading profile:', error);
            }
        }

        function blobToDataURL(blob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }

        // Load application history
        async function loadApplicationHistory() {
            console.log('📖 Loading application history...');
            
            // Refresh user data
            userData = JSON.parse(localStorage.getItem('userData') || '{}');
            
            if (!userData.email) {
                console.log('⚠️ No user email found, skipping application history');
                return;
            }
            
            console.log('👤 Loading history for user:', userData.email);
            
            try {
                console.log('🔄 Fetching from /api/users/application-history...');
                const response = await fetch('/api/users/application-history', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                    }
                });

                console.log('📡 Application history response status:', response.status);

                if (!response.ok) {
                    const errorText = await response.text();
                    console.log('⚠️ No application history found:', response.status, errorText);
                    return;
                }

                const data = await response.json();
                console.log('📦 Application history data received:', data);
                
                if (data.success && data.applicationHistory && data.applicationHistory.length > 0) {
                    const applicationHistory = data.applicationHistory;
                    console.log('✅ Loaded application history:', applicationHistory.length, 'items');
                    console.log('📋 First application:', applicationHistory[0]);
                    
                    const badge = document.getElementById('employersBadge');
                    const count = Math.min(applicationHistory.length, 5);
                    badge.textContent = count;
                    console.log('🔢 Updated badge count:', count);
                    
                    renderEmployers(applicationHistory.slice(0, 5));
                    console.log('✅ Rendered employers');
                } else {
                    console.log('ℹ️ No application history found or empty array');
                }
            } catch (error) {
                console.error('❌ Error loading application history:', error);
            }
        }

        // Mark application as replied - Global variables for modal
        let currentReplyAppId = null;
        let currentReplyCompanyName = '';

        function markAsReplied(appId, companyName) {
            currentReplyAppId = appId;
            currentReplyCompanyName = companyName;
            
            // Set the company name in the modal
            document.getElementById('replyCompanyName').textContent = companyName;
            
            // Set default date to today
            const today = new Date().toISOString().split('T')[0];
            document.getElementById('replyDateInput').value = today;
            
            // Show the modal
            document.getElementById('replyModal').classList.add('active');
        }

        function closeReplyModal() {
            document.getElementById('replyModal').classList.remove('active');
            currentReplyAppId = null;
            currentReplyCompanyName = '';
        }

        // Show all replies for an application (fetch from API)
        async function showAllReplies(applicationId, companyName) {
            try {
                const response = await fetch(`/api/users/application-history/${applicationId}/replies`, {
                    headers: {
                        'Authorization': `Bearer ${authToken}`
                    }
                });

                if (!response.ok) {
                    throw new Error('Failed to fetch replies');
                }

                const result = await response.json();
                
                if (result.success && result.replies && result.replies.length > 0) {
                    // Build HTML for all replies with compact card design
                    const repliesHtml = result.replies.map((reply, index) => {
                        const replyDate = new Date(reply.replyDate).toLocaleString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit'
                        });
                        
                        // Subtle color variations
                        const colors = [
                            { bg: '#eff6ff', accent: '#3b82f6' },
                            { bg: '#f5f3ff', accent: '#8b5cf6' },
                            { bg: '#ecfdf5', accent: '#10b981' },
                            { bg: '#fef3c7', accent: '#f59e0b' }
                        ];
                        const color = colors[index % colors.length];
                        
                        return `
                            <div style="background: ${color.bg}; border-left: 3px solid ${color.accent}; border-radius: 6px; padding: 12px 14px; margin-bottom: 12px;">
                                <!-- Header: Badge + From + Date -->
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
                                    <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
                                        <span style="background: ${color.accent}; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; flex-shrink: 0;">#${result.replies.length - index}</span>
                                        <span style="font-size: 0.875rem; color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">✉️ ${reply.replyFromEmail}</span>
                                    </div>
                                    <span style="font-size: 0.8rem; color: #6b7280; white-space: nowrap;">📅 ${replyDate}</span>
                                </div>
                                
                                <!-- Subject -->
                                <div style="font-size: 0.875rem; color: #1f2937; font-weight: 500; margin-bottom: 8px; line-height: 1.4;">
                                    ${reply.replySubject || '(No Subject)'}
                                </div>
                                
                                <!-- Preview -->
                                <div style="background: white; border-radius: 4px; padding: 10px; font-size: 0.85rem; color: #4b5563; line-height: 1.5; max-height: 100px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word;">${reply.replySnippet || '(No preview available)'}</div>
                            </div>
                        `;
                    }).join('');

                    // Update modal content
                    document.getElementById('replyDetailsCompany').textContent = companyName;
                    document.getElementById('replyDetailsContent').innerHTML = `
                        <div style="background: #f1f5f9; padding: 10px 14px; border-radius: 6px; margin-bottom: 14px;">
                            <span style="font-size: 0.95rem; font-weight: 600; color: #374151;">
                                ${result.count} ${result.count === 1 ? 'Reply' : 'Replies'} Received
                            </span>
                        </div>
                        ${repliesHtml}
                    `;
                    
                    // Show modal
                    document.getElementById('replyDetailsModal').classList.add('active');
                } else {
                    showToast('No replies found', 'info');
                }
            } catch (error) {
                console.error('Error fetching replies:', error);
                showToast('Failed to load replies', 'error');
            }
        }

        // Show reply details (legacy - for single reply)
        function showReplyDetails(companyName, fromEmail, subject, snippet, replyDate) {
            document.getElementById('replyDetailsCompany').textContent = companyName;
            document.getElementById('replyDetailsFrom').textContent = fromEmail || 'N/A';
            document.getElementById('replyDetailsSubject').textContent = subject || '(No Subject)';
            document.getElementById('replyDetailsDate').textContent = replyDate || 'N/A';
            document.getElementById('replyDetailsSnippet').textContent = snippet || 'No preview available';
            
            // Show detail fields
            document.getElementById('replyDetailsSubject').style.display = 'block';
            document.getElementById('replyDetailsDate').style.display = 'block';
            document.getElementById('replyDetailsSnippet').style.display = 'block';
            
            document.getElementById('replyDetailsModal').classList.add('active');
        }

        function closeReplyDetailsModal() {
            document.getElementById('replyDetailsModal').classList.remove('active');
        }

        async function confirmMarkAsReplied() {
            const replyDate = document.getElementById('replyDateInput').value;
            
            if (!replyDate) {
                showToast('Please select a reply date', 'error');
                return;
            }

            // Save the ID before closing the modal (which resets it to null)
            const appId = currentReplyAppId;
            
            if (!appId) {
                showToast('Error: Application ID not found', 'error');
                return;
            }

            try {
                // Close the modal
                closeReplyModal();
                
                console.log('🔄 Marking as replied:', { id: appId, replyDate });
                
                // Update the specific application using PATCH
                const response = await fetch(`/api/users/application-history/${appId}`, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        replyReceived: true,
                        replyDate: replyDate
                    })
                });

                console.log('📡 Response status:', response.status, response.statusText);
                
                if (response.ok) {
                    const data = await response.json();
                    console.log('✅ Success:', data);
                    showToast('Application marked as replied!', 'success');
                    // Reload the application history to reflect changes
                    loadApplicationHistory();
                } else {
                    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                    console.error('❌ Error response:', response.status, errorData);
                    showToast('Failed to save changes: ' + (errorData.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('❌ Error marking as replied:', error);
                showToast('Failed to update application: ' + error.message, 'error');
            }
        }

        function renderEmployers(employers) {
            console.log('🎨 Rendering employers...', employers ? employers.length : 0);
            const container = document.getElementById('employersContainer');
            
            if (!container) {
                console.error('❌ employersContainer element not found!');
                return;
            }
            
            if (!employers || employers.length === 0) {
                console.log('📭 No employers to display, showing empty state');
                document.getElementById('emptyState').style.display = 'block';
                container.innerHTML = '';
                return;
            }
            document.getElementById('emptyState').style.display = 'none';

            console.log('📊 Processing', employers.length, 'employers');
            
            const html = employers.map((employer, index) => {
                console.log(`  Processing employer ${index + 1}:`, employer);
                
                // Format sentDate
                let sentDate = 'N/A';
                if (employer.sentDate) {
                    try {
                        const date = new Date(employer.sentDate);
                        if (!isNaN(date.getTime())) {
                            sentDate = date.toLocaleDateString('en-US', { 
                                month: 'short', 
                                day: 'numeric', 
                                year: 'numeric' 
                            });
                        }
                    } catch (e) {
                        console.error('Error parsing sentDate:', e);
                    }
                }
                
                // Format replyDate
                const replyDate = employer.replyReceived && employer.replyDate 
                    ? (() => {
                        try {
                            const date = new Date(employer.replyDate);
                            return !isNaN(date.getTime()) ? date.toLocaleDateString('en-US', { 
                                month: 'short', 
                                day: 'numeric', 
                                year: 'numeric' 
                            }) : null;
                        } catch (e) {
                            return null;
                        }
                    })()
                    : null;
                
                const isClickable = !employer.replyReceived;
                const clickableClass = isClickable ? 'employer-card-clickable' : '';
                
                return `
                    <div class="employer-card ${clickableClass}" data-app-id="${employer.id}" onclick="${isClickable ? `markAsReplied(${employer.id}, '${employer.companyName}')` : ''}">
                        <div class="status-indicator ${employer.replyReceived ? 'status-replied' : 'status-pending'}"></div>
                        <div class="employer-card-content">
                            <div class="employer-header">
                                <div style="display: flex; align-items: start;">
                                    <span class="employer-number-badge">${index + 1}</span>
                                    <div class="employer-info">
                                        <div class="employer-company-name">${employer.companyName}</div>
                                        <div class="employer-job-position">${employer.position}</div>
                                    </div>
                                </div>
                                <span class="status-badge ${employer.replyReceived ? 'status-badge-replied' : 'status-badge-pending'}">
                                    ${employer.replyReceived ? '✓ Replied' : '⏳ Pending'}
                                </span>
                            </div>
                            <div class="employer-dates">
                                <div style="display: flex; gap: 12px; flex-wrap: nowrap;">
                                    <div class="employer-date-item">
                                        <div class="employer-date-label">Sent</div>
                                        <div class="employer-date-value">${sentDate}</div>
                                    </div>
                                    ${employer.replyReceived && replyDate ? `
                                        <div class="employer-date-item">
                                            <div class="employer-date-label">Latest Reply</div>
                                            <div class="employer-date-value">${replyDate}</div>
                                        </div>
                                    ` : ''}
                                </div>
                                ${!employer.replyReceived ? `
                                    <div style="font-size: 0.875rem; color: #059669; font-weight: 500; white-space: nowrap;">
                                        ✓ Tap to mark as replied
                                    </div>
                                ` : employer.replySnippet ? `
                                    <button class="btn btn-secondary" onclick="event.stopPropagation(); showAllReplies(${employer.id}, '${employer.companyName}')" style="padding: 6px 12px; font-size: 0.875rem; margin-top: 8px;">
                                        📬 Show ${employer.replyCount > 1 ? employer.replyCount + ' Replies' : 'Reply'}
                                    </button>
                                ` : ''}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
            
            console.log('📝 Setting innerHTML for employers');
            container.innerHTML = html;
            console.log('✅ Employers rendered successfully');
        }

        // Load statistics
        async function loadDashboardStatistics() {
            console.log('📊 Loading dashboard statistics...');
            
            // Refresh user data from localStorage
            userData = JSON.parse(localStorage.getItem('userData') || '{}');
            
            const userName = userData.fullName || userData.name || userData.email || 'User';
            console.log('👤 Setting welcome message for:', userName);
            document.getElementById('dashboardUserName').textContent = userName;
            
            // Show "Check for Replies" button for OAuth users (Google or Microsoft)
            const provider = userData.provider || userData.oauth_provider;
            console.log('🔐 User OAuth provider:', provider);
            
            if (provider === 'microsoft') {
                console.log('✅ Microsoft OAuth user - showing Check for Replies button');
                document.getElementById('checkRepliesContainer').style.display = 'block';
            } else {
                console.log('ℹ️ Non-Microsoft user - hiding Check for Replies button');
                document.getElementById('checkRepliesContainer').style.display = 'none';
            }
            
            try {
                console.log('🔄 Fetching counters from /api/users/counters...');
                const countersResponse = await fetch('/api/users/counters', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                    }
                });

                let totalSent = 0, totalGenerated = 0;
                
                console.log('📡 Counters response status:', countersResponse.status);
                
                if (countersResponse.ok) {
                    const countersData = await countersResponse.json();
                    console.log('📊 Counters data received:', countersData);
                    
                    totalSent = countersData.totalSent || 0;
                    totalGenerated = countersData.totalGenerated || 0;
                    console.log('✅ Loaded counters - Sent:', totalSent, 'Generated:', totalGenerated);
                } else {
                    const errorText = await countersResponse.text();
                    console.log('⚠️ Failed to load counters:', countersResponse.status, errorText);
                }
                
                console.log('📝 Setting dashboard values - Sent:', totalSent, 'Generated:', totalGenerated);
                document.getElementById('dashboardTotalSent').textContent = totalSent;
                document.getElementById('dashboardTotalGenerated').textContent = totalGenerated;
                console.log('✅ Dashboard statistics updated');
            } catch (error) {
                console.error('❌ Error loading statistics:', error);
                document.getElementById('dashboardTotalSent').textContent = '0';
                document.getElementById('dashboardTotalGenerated').textContent = '0';
            }
        }

        // Toast notification
        function showToast(message, type = 'success') {
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.innerHTML = `
                <span>${type === 'success' ? '✓' : '✗'}</span>
                <span>${message}</span>
            `;
            
            document.body.appendChild(toast);
            
            setTimeout(() => {
                toast.style.animation = 'slideInRight 0.3s ease-out reverse';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }

        // Silent auto-check for replies (no UI updates, runs in background)
        async function autoCheckForReplies(showNotification = false) {
            try {
                console.log('🔄 Auto-checking for email replies...');
                const response = await fetch('/api/check-replies', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                    }
                });

                const result = await response.json();
                
                if (response.ok) {
                    const repliesCount = result.repliesFound || 0;
                    console.log(`✅ Auto-check complete: ${repliesCount} replies found`);
                    
                    if (repliesCount > 0) {
                        // Reload application history to show updated reply status
                        await loadApplicationHistory();
                        
                        if (showNotification) {
                            showToast(`Auto-sync: Found ${repliesCount} new ${repliesCount === 1 ? 'reply' : 'replies'}!`, 'success');
                        }
                    }
                } else {
                    console.error('❌ Auto-check error:', result.error || result.message);
                }
            } catch (error) {
                console.error('❌ Auto-check network error:', error);
            }
        }

        // Check for email replies (OAuth users only) - Manual button click
        async function checkForReplies() {
            const btn = document.getElementById('checkRepliesBtn');
            const status = document.getElementById('repliesStatus');
            
            // Gmail auto-reply checking disabled until CASA — show info message
            const currentUserData = JSON.parse(localStorage.getItem('userData') || '{}');
            const currentProvider = currentUserData.provider || currentUserData.oauth_provider;
            if (currentProvider === 'google') {
                status.innerHTML = '<strong>📬 Gmail — Coming Soon</strong><br>Automatic reply checking currently works only with Microsoft/Outlook email. Gmail feature coming soon.<br><br>Please check your mails manually and click on the application card to mark it as replied.';
                status.style.backgroundColor = '#fff3cd';
                status.style.color = '#856404';
                status.style.border = '1px solid #ffc107';
                status.style.display = 'block';
                return;
            }
            
            // Disable button and show loading state
            btn.disabled = true;
            btn.innerHTML = '<span>⏳</span><span>Checking...</span>';
            status.style.display = 'none';
            
            try {
                const response = await fetch('/api/check-replies', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'Content-Type': 'application/json',
                    }
                });

                const result = await response.json();
                
                if (response.ok) {
                    const repliesCount = result.repliesFound || 0;
                    
                    // Show success message
                    status.innerHTML = `<strong>✓ Check Complete</strong><br>${repliesCount} ${repliesCount === 1 ? 'reply' : 'replies'} found`;
                    status.style.backgroundColor = '#d4edda';
                    status.style.color = '#155724';
                    status.style.border = '1px solid #c3e6cb';
                    status.style.display = 'block';
                    
                    if (repliesCount > 0) {
                        showToast(`Found ${repliesCount} ${repliesCount === 1 ? 'reply' : 'replies'}!`, 'success');
                        
                        // Reload application history to show updated reply status
                        setTimeout(() => {
                            loadApplicationHistory();
                        }, 1000);
                    } else {
                        showToast('No new replies found', 'success');
                    }
                } else {
                    // Show error message
                    const errorMsg = result.error || result.message || 'Failed to check for replies';
                    status.innerHTML = `<strong>✗ Error</strong><br>${errorMsg}`;
                    status.style.backgroundColor = '#f8d7da';
                    status.style.color = '#721c24';
                    status.style.border = '1px solid #f5c6cb';
                    status.style.display = 'block';
                    
                    showToast(errorMsg, 'error');
                }
            } catch (error) {
                console.error('Error checking replies:', error);
                
                status.innerHTML = '<strong>✗ Error</strong><br>Network error. Please try again.';
                status.style.backgroundColor = '#f8d7da';
                status.style.color = '#721c24';
                status.style.border = '1px solid #f5c6cb';
                status.style.display = 'block';
                
                showToast('Network error. Please try again.', 'error');
            } finally {
                // Re-enable button
                btn.disabled = false;
                btn.innerHTML = '<span style="font-size: 1.1rem;">📬</span><span>Check for Replies</span>';
            }
        }

        // Start periodic reply checking (every 10 minutes)
        let replyCheckInterval = null;
        function startPeriodicReplyCheck() {
            const userData = JSON.parse(localStorage.getItem('userData') || '{}');
            const isMicrosoftUser = userData.provider === 'microsoft';
            
            if (isMicrosoftUser && !replyCheckInterval) {
                console.log('🔄 Starting periodic reply check (every 10 minutes)');
                
                // Initial check after 30 seconds
                setTimeout(() => autoCheckForReplies(false), 30000);
                
                // Then check every 10 minutes
                replyCheckInterval = setInterval(() => {
                    autoCheckForReplies(true); // Show notification on periodic checks
                }, 10 * 60 * 1000); // 10 minutes
            }
        }

        function stopPeriodicReplyCheck() {
            if (replyCheckInterval) {
                console.log('⏸️ Stopping periodic reply check');
                clearInterval(replyCheckInterval);
                replyCheckInterval = null;
            }
        }

        // Initialize on page load
        document.addEventListener('DOMContentLoaded', () => {
            console.log('🚀 ========================================');
            console.log('🚀 Initializing dashboard...');
            console.log('🚀 ========================================');
            
            // Check all required elements
            const requiredElements = {
                'dashboardUserName': document.getElementById('dashboardUserName'),
                'dashboardTotalSent': document.getElementById('dashboardTotalSent'),
                'dashboardTotalGenerated': document.getElementById('dashboardTotalGenerated'),
                'employersContainer': document.getElementById('employersContainer'),
                'employersBadge': document.getElementById('employersBadge'),
            };
            
            console.log('🔍 Checking required elements:');
            Object.entries(requiredElements).forEach(([name, element]) => {
                if (element) {
                    console.log(`  ✅ ${name} found`);
                } else {
                    console.error(`  ❌ ${name} NOT FOUND!`);
                }
            });
            
            // Initialize WOW.js for animations
            console.log('✨ Initializing WOW.js animations');
            // new WOW().init();
            
            // Load all data
            console.log('📊 Loading dashboard data...');
            Promise.all([
                restoreFormValues(),
                loadDashboardStatistics(),
                loadApplicationHistory(),
                loadProfile()
            ]).then(() => {
                console.log('✅ All data loaded successfully');
                console.log('🚀 ========================================');
                
                // Auto-check for replies on load (OAuth users only)
                const userData = JSON.parse(localStorage.getItem('userData') || '{}');
                const isOAuthUser = userData.provider === 'google' || userData.provider === 'microsoft';
                if (isOAuthUser) {
                    console.log('🔄 Starting auto-check for replies...');
                    autoCheckForReplies(false);
                    startPeriodicReplyCheck();
                }
            }).catch(error => {
                console.error('❌ Error loading data:', error);
            });
            
            // Close modals on click outside
            const settingsModal = document.getElementById('settingsModal');
            const profileModal = document.getElementById('profileModal');
            const replyModal = document.getElementById('replyModal');
            const replyDetailsModal = document.getElementById('replyDetailsModal');
            
            if (settingsModal) {
                settingsModal.addEventListener('click', function(e) {
                    if (e.target === this) closeSettings();
                });
                console.log('✅ Settings modal event listener added');
            }
            
            if (profileModal) {
                profileModal.addEventListener('click', function(e) {
                    if (e.target === this) closeProfile();
                });
                console.log('✅ Profile modal event listener added');
            }
            
            if (replyModal) {
                replyModal.addEventListener('click', function(e) {
                    if (e.target === this) closeReplyModal();
                });
                console.log('✅ Reply modal event listener added');
            }
            
            if (replyDetailsModal) {
                replyDetailsModal.addEventListener('click', function(e) {
                    if (e.target === this) closeReplyDetailsModal();
                });
                console.log('✅ Reply details modal event listener added');
            }
            
            console.log('✅ Dashboard initialized');
            console.log('🚀 ========================================');
        });
