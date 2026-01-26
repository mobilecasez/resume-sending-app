// Credit Validation Modal
(function() {
    'use strict';

    // Modal HTML
    const modalHTML = `
        <div id="creditModal" class="credit-modal" style="display: none;">
            <div class="credit-modal-overlay"></div>
            <div class="credit-modal-content">
                <div class="credit-modal-icon">💳</div>
                <h2 class="credit-modal-title">Insufficient Credits</h2>
                <p class="credit-modal-message">
                    Remaining credits are <strong>0</strong>. Please recharge to continue sending applications and generating cover letters.
                </p>
                <div class="credit-modal-actions">
                    <button class="credit-modal-btn credit-modal-btn-cancel" onclick="creditValidation.closeModal()">
                        Cancel
                    </button>
                    <button class="credit-modal-btn credit-modal-btn-recharge" onclick="creditValidation.goToPackages()">
                        💎 Recharge Now
                    </button>
                </div>
            </div>
        </div>
    `;

    // Modal styles
    const modalStyles = `
        <style id="credit-modal-styles">
            .credit-modal {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .credit-modal-overlay {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.6);
                backdrop-filter: blur(4px);
            }

            .credit-modal-content {
                position: relative;
                background: white;
                border-radius: 16px;
                padding: 40px;
                max-width: 480px;
                width: 90%;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                text-align: center;
                animation: modalSlideIn 0.3s ease-out;
            }

            @keyframes modalSlideIn {
                from {
                    opacity: 0;
                    transform: translateY(-20px) scale(0.95);
                }
                to {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                }
            }

            .credit-modal-icon {
                font-size: 4rem;
                margin-bottom: 20px;
            }

            .credit-modal-title {
                font-size: 1.75rem;
                font-weight: 700;
                color: #1F2937;
                margin-bottom: 16px;
            }

            .credit-modal-message {
                font-size: 1.125rem;
                color: #6B7280;
                line-height: 1.6;
                margin-bottom: 32px;
            }

            .credit-modal-message strong {
                color: #EF4444;
                font-weight: 700;
            }

            .credit-modal-actions {
                display: flex;
                gap: 12px;
                justify-content: center;
            }

            .credit-modal-btn {
                padding: 14px 28px;
                border-radius: 8px;
                font-size: 1rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                border: none;
                min-width: 140px;
            }

            .credit-modal-btn-cancel {
                background: #F3F4F6;
                color: #6B7280;
            }

            .credit-modal-btn-cancel:hover {
                background: #E5E7EB;
            }

            .credit-modal-btn-recharge {
                background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
                color: white;
                box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
            }

            .credit-modal-btn-recharge:hover {
                box-shadow: 0 6px 16px rgba(99, 102, 241, 0.4);
                transform: translateY(-1px);
            }

            @media (max-width: 640px) {
                .credit-modal-content {
                    padding: 32px 24px;
                }

                .credit-modal-actions {
                    flex-direction: column-reverse;
                }

                .credit-modal-btn {
                    width: 100%;
                }
            }
        </style>
    `;

    // Credit Validation Object
    window.creditValidation = {
        // Initialize modal
        init: function() {
            // Inject styles if not already present
            if (!document.getElementById('credit-modal-styles')) {
                document.head.insertAdjacentHTML('beforeend', modalStyles);
            }

            // Inject modal HTML if not already present
            if (!document.getElementById('creditModal')) {
                document.body.insertAdjacentHTML('beforeend', modalHTML);
            }
        },

        // Check if user has credits
        checkCredits: async function() {
            const token = localStorage.getItem('authToken');
            if (!token) return false;

            try {
                const response = await fetch('/api/user/credits', {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                if (!response.ok) return false;

                const data = await response.json();
                return data.success && data.balance > 0;
            } catch (error) {
                console.error('Error checking credits:', error);
                return false;
            }
        },

        // Show modal
        showModal: function() {
            const modal = document.getElementById('creditModal');
            if (modal) {
                modal.style.display = 'flex';
                document.body.style.overflow = 'hidden';
            }
        },

        // Close modal
        closeModal: function() {
            const modal = document.getElementById('creditModal');
            if (modal) {
                modal.style.display = 'none';
                document.body.style.overflow = '';
            }
        },

        // Go to packages page
        goToPackages: function() {
            window.location.href = '/packages';
        },

        // Validate and execute action
        validateAndExecute: async function(action) {
            const hasCredits = await this.checkCredits();
            
            if (!hasCredits) {
                this.showModal();
                return false;
            }

            if (typeof action === 'function') {
                return action();
            }

            return true;
        }
    };

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            creditValidation.init();
        });
    } else {
        creditValidation.init();
    }
})();
