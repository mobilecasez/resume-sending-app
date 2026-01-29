import React, { useState, useEffect } from 'react';
import { 
    View, 
    Text, 
    StyleSheet, 
    ScrollView, 
    ActivityIndicator, 
    TouchableOpacity,
    Dimensions,
    RefreshControl
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../config';

const { width } = Dimensions.get('window');

export default function UsageScreen({ navigation }) {
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [credits, setCredits] = useState(null);
    const [currentMonth, setCurrentMonth] = useState(null);
    const [history, setHistory] = useState([]);
    const [error, setError] = useState('');

    useEffect(() => {
        fetchUsageStats();
    }, []);

    const fetchUsageStats = async () => {
        try {
            setError('');
            const token = await AsyncStorage.getItem('userToken');
            
            if (!token) {
                navigation.navigate('Login');
                return;
            }

            const response = await fetch(`${API_BASE}/user/usage-stats`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to fetch usage statistics');
            }

            if (data.success) {
                setCredits(data.credits);
                setCurrentMonth(data.currentMonth);
                setHistory(data.history);
            }
        } catch (err) {
            console.error('Error fetching usage stats:', err);
            setError(err.message || 'Failed to load usage statistics');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    const onRefresh = () => {
        setRefreshing(true);
        fetchUsageStats();
    };

    const renderProgressBar = (used, total, label) => {
        const percentage = total > 0 ? (used / total) * 100 : 0;
        const barWidth = Math.min(percentage, 100);

        return (
            <View style={styles.progressContainer}>
                <View style={styles.progressHeader}>
                    <Text style={styles.progressLabel}>{label}</Text>
                    <Text style={styles.progressValue}>{used} / {total}</Text>
                </View>
                <View style={styles.progressBarBackground}>
                    <View style={[styles.progressBarFill, { width: `${barWidth}%` }]} />
                </View>
                <Text style={styles.progressPercentage}>{percentage.toFixed(0)}% used</Text>
            </View>
        );
    };

    const formatMonthYear = (month, year) => {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${months[month - 1]} ${year}`;
    };

    const formatDate = (dateString) => {
        if (!dateString) return 'No expiry';
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
    };

    const isExpiringSoon = (dateString) => {
        if (!dateString) return false;
        const expiryDate = new Date(dateString);
        const now = new Date();
        const daysUntilExpiry = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));
        return daysUntilExpiry <= 7 && daysUntilExpiry > 0;
    };

    const isExpired = (dateString) => {
        if (!dateString) return false;
        const expiryDate = new Date(dateString);
        const now = new Date();
        return expiryDate < now;
    };

    if (loading) {
        return (
            <View style={styles.centerContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>Loading usage statistics...</Text>
            </View>
        );
    }

    return (
        <ScrollView 
            style={styles.container}
            refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
        >
            {/* Header */}
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Usage & Credits</Text>
                <Text style={styles.headerSubtitle}>Track your cover letter generation</Text>
            </View>

            {error ? (
                <View style={styles.errorContainer}>
                    <Text style={styles.errorText}>{error}</Text>
                    <TouchableOpacity style={styles.retryButton} onPress={fetchUsageStats}>
                        <Text style={styles.retryButtonText}>Retry</Text>
                    </TouchableOpacity>
                </View>
            ) : null}

            {/* Credits Card */}
            <View style={styles.card}>
                <View style={styles.cardHeader}>
                    <Text style={styles.cardTitle}>💳 Credits Balance</Text>
                    <TouchableOpacity 
                        style={styles.purchaseButton}
                        onPress={() => navigation.navigate('Plans')}
                    >
                        <Text style={styles.purchaseButtonText}>+ Buy Credits</Text>
                    </TouchableOpacity>
                </View>

                <View style={styles.creditsContainer}>
                    <View style={styles.creditsMain}>
                        <Text style={styles.creditsCount}>{credits?.remaining || 0}</Text>
                        <Text style={styles.creditsLabel}>Credits Remaining</Text>
                    </View>

                    {credits?.expiryDate && (
                        <View style={styles.expiryContainer}>
                            <Text style={styles.expiryLabel}>Expires:</Text>
                            <Text style={[
                                styles.expiryDate,
                                isExpired(credits.expiryDate) && styles.expiredText,
                                isExpiringSoon(credits.expiryDate) && styles.expiringSoonText
                            ]}>
                                {formatDate(credits.expiryDate)}
                                {isExpiringSoon(credits.expiryDate) && ' ⚠️'}
                                {isExpired(credits.expiryDate) && ' ❌'}
                            </Text>
                        </View>
                    )}
                </View>

                {(credits?.remaining || 0) === 0 && (
                    <View style={styles.warningBox}>
                        <Text style={styles.warningText}>
                            ⚠️ You're out of credits! Purchase a plan to continue generating cover letters.
                        </Text>
                    </View>
                )}

                {isExpiringSoon(credits?.expiryDate) && (
                    <View style={styles.warningBox}>
                        <Text style={styles.warningText}>
                            ⚠️ Your credits expire soon! Consider purchasing a new plan.
                        </Text>
                    </View>
                )}
            </View>

            {/* Current Month Usage */}
            {currentMonth && (
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>
                        📊 {formatMonthYear(currentMonth.month, currentMonth.year)} Usage
                    </Text>

                    {renderProgressBar(
                        currentMonth.creditsUsed || 0,
                        credits?.total || 0,
                        'Credits Used This Month'
                    )}

                    <View style={styles.statsRow}>
                        <View style={styles.statBox}>
                            <Text style={styles.statValue}>{currentMonth.lettersGenerated || 0}</Text>
                            <Text style={styles.statLabel}>Generated</Text>
                        </View>
                        <View style={styles.statBox}>
                            <Text style={styles.statValue}>{currentMonth.lettersSent || 0}</Text>
                            <Text style={styles.statLabel}>Sent</Text>
                        </View>
                    </View>
                </View>
            )}

            {/* Historical Usage */}
            {history && history.length > 0 && (
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>📈 Usage History</Text>
                    {history.map((item, index) => (
                        <View key={index} style={styles.historyItem}>
                            <View style={styles.historyHeader}>
                                <Text style={styles.historyMonth}>
                                    {formatMonthYear(item.month, item.year)}
                                </Text>
                                <Text style={styles.historyCredits}>{item.credits_used} credits</Text>
                            </View>
                            <View style={styles.historyStats}>
                                <Text style={styles.historyStatText}>
                                    {item.letters_generated} generated
                                </Text>
                                <Text style={styles.historyStatDivider}>•</Text>
                                <Text style={styles.historyStatText}>
                                    {item.letters_sent} sent
                                </Text>
                            </View>
                        </View>
                    ))}
                </View>
            )}

            {/* Action Buttons */}
            <View style={styles.actionsContainer}>
                <TouchableOpacity 
                    style={styles.actionButton}
                    onPress={() => navigation.navigate('Plans')}
                >
                    <Text style={styles.actionButtonText}>View Plans & Pricing</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                    style={[styles.actionButton, styles.secondaryButton]}
                    onPress={() => navigation.navigate('PurchaseHistory')}
                >
                    <Text style={[styles.actionButtonText, styles.secondaryButtonText]}>
                        Purchase History
                    </Text>
                </TouchableOpacity>
            </View>

            <View style={styles.bottomPadding} />
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F5F7FA',
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#F5F7FA',
    },
    loadingText: {
        marginTop: 16,
        fontSize: 16,
        color: '#666',
    },
    header: {
        paddingVertical: 24,
        paddingHorizontal: 20,
        backgroundColor: '#007AFF',
    },
    headerTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        color: '#FFFFFF',
        marginBottom: 4,
    },
    headerSubtitle: {
        fontSize: 15,
        color: '#FFFFFF',
        opacity: 0.9,
    },
    errorContainer: {
        margin: 16,
        padding: 16,
        backgroundColor: '#FEE',
        borderRadius: 8,
        borderLeftWidth: 4,
        borderLeftColor: '#F44',
    },
    errorText: {
        color: '#C00',
        fontSize: 14,
        marginBottom: 8,
    },
    retryButton: {
        backgroundColor: '#F44',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 6,
        alignSelf: 'flex-start',
    },
    retryButtonText: {
        color: '#FFF',
        fontWeight: '600',
        fontSize: 14,
    },
    card: {
        backgroundColor: '#FFFFFF',
        marginHorizontal: 16,
        marginTop: 16,
        padding: 20,
        borderRadius: 12,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
    },
    cardTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: '#1A1A1A',
        marginBottom: 16,
    },
    purchaseButton: {
        backgroundColor: '#34C759',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 8,
    },
    purchaseButtonText: {
        color: '#FFF',
        fontWeight: '600',
        fontSize: 14,
    },
    creditsContainer: {
        alignItems: 'center',
    },
    creditsMain: {
        alignItems: 'center',
        marginBottom: 16,
    },
    creditsCount: {
        fontSize: 56,
        fontWeight: 'bold',
        color: '#007AFF',
    },
    creditsLabel: {
        fontSize: 16,
        color: '#666',
        marginTop: 4,
    },
    expiryContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 16,
        backgroundColor: '#F5F7FA',
        borderRadius: 8,
    },
    expiryLabel: {
        fontSize: 14,
        color: '#666',
        marginRight: 8,
    },
    expiryDate: {
        fontSize: 14,
        fontWeight: '600',
        color: '#1A1A1A',
    },
    expiredText: {
        color: '#F44',
    },
    expiringSoonText: {
        color: '#FF9500',
    },
    warningBox: {
        marginTop: 16,
        padding: 12,
        backgroundColor: '#FFF3CD',
        borderRadius: 8,
        borderLeftWidth: 4,
        borderLeftColor: '#FF9500',
    },
    warningText: {
        fontSize: 14,
        color: '#856404',
    },
    progressContainer: {
        marginVertical: 12,
    },
    progressHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    progressLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: '#1A1A1A',
    },
    progressValue: {
        fontSize: 14,
        fontWeight: '600',
        color: '#007AFF',
    },
    progressBarBackground: {
        height: 12,
        backgroundColor: '#E5E5EA',
        borderRadius: 6,
        overflow: 'hidden',
    },
    progressBarFill: {
        height: '100%',
        backgroundColor: '#007AFF',
        borderRadius: 6,
    },
    progressPercentage: {
        fontSize: 12,
        color: '#666',
        marginTop: 4,
    },
    statsRow: {
        flexDirection: 'row',
        marginTop: 16,
        gap: 16,
    },
    statBox: {
        flex: 1,
        backgroundColor: '#F5F7FA',
        padding: 16,
        borderRadius: 8,
        alignItems: 'center',
    },
    statValue: {
        fontSize: 28,
        fontWeight: 'bold',
        color: '#007AFF',
    },
    statLabel: {
        fontSize: 14,
        color: '#666',
        marginTop: 4,
    },
    historyItem: {
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#E5E5EA',
    },
    historyHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 6,
    },
    historyMonth: {
        fontSize: 16,
        fontWeight: '600',
        color: '#1A1A1A',
    },
    historyCredits: {
        fontSize: 14,
        fontWeight: '600',
        color: '#007AFF',
    },
    historyStats: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    historyStatText: {
        fontSize: 14,
        color: '#666',
    },
    historyStatDivider: {
        marginHorizontal: 8,
        color: '#CCC',
    },
    actionsContainer: {
        marginHorizontal: 16,
        marginTop: 16,
    },
    actionButton: {
        backgroundColor: '#007AFF',
        paddingVertical: 16,
        borderRadius: 12,
        alignItems: 'center',
        marginBottom: 12,
    },
    actionButtonText: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: '600',
    },
    secondaryButton: {
        backgroundColor: '#FFFFFF',
        borderWidth: 2,
        borderColor: '#007AFF',
    },
    secondaryButtonText: {
        color: '#007AFF',
    },
    bottomPadding: {
        height: 40,
    },
});
