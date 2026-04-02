import React, { useState, useEffect } from 'react';
import { 
    View, 
    Text, 
    StyleSheet, 
    ScrollView, 
    ActivityIndicator,
    RefreshControl
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../../config';

export default function PurchaseHistoryScreen({ navigation }) {
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [transactions, setTransactions] = useState([]);
    const [error, setError] = useState('');

    useEffect(() => {
        fetchPurchaseHistory();
    }, []);

    const fetchPurchaseHistory = async () => {
        try {
            setError('');
            const token = await AsyncStorage.getItem('userToken');
            
            if (!token) {
                navigation.navigate('Login');
                return;
            }

            const response = await fetch(`${API_BASE}/user/purchase-history`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to fetch purchase history');
            }

            if (data.success) {
                setTransactions(data.transactions);
            }
        } catch (err) {
            console.error('Error fetching purchase history:', err);
            setError(err.message || 'Failed to load purchase history');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    const onRefresh = () => {
        setRefreshing(true);
        fetchPurchaseHistory();
    };

    const formatDate = (dateString) => {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const getStatusColor = (status) => {
        switch (status) {
            case 'completed':
                return '#34C759';
            case 'pending':
                return '#FF9500';
            case 'failed':
                return '#FF3B30';
            default:
                return '#666';
        }
    };

    const getStatusIcon = (status) => {
        switch (status) {
            case 'completed':
                return '✓';
            case 'pending':
                return '⏱';
            case 'failed':
                return '✗';
            default:
                return '•';
        }
    };

    if (loading) {
        return (
            <View style={styles.centerContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>Loading purchase history...</Text>
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
                <Text style={styles.headerTitle}>Purchase History</Text>
                <Text style={styles.headerSubtitle}>Your credit purchase transactions</Text>
            </View>

            {error ? (
                <View style={styles.errorContainer}>
                    <Text style={styles.errorText}>{error}</Text>
                </View>
            ) : null}

            {transactions.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyIcon}>📦</Text>
                    <Text style={styles.emptyTitle}>No Purchases Yet</Text>
                    <Text style={styles.emptyText}>
                        Your purchase history will appear here once you buy a plan.
                    </Text>
                </View>
            ) : (
                <View style={styles.transactionsContainer}>
                    {transactions.map((transaction) => (
                        <View key={transaction.id} style={styles.transactionCard}>
                            <View style={styles.transactionHeader}>
                                <View style={styles.planInfo}>
                                    <Text style={styles.planName}>
                                        {transaction.plan_name}
                                    </Text>
                                    <View style={[
                                        styles.statusBadge,
                                        { backgroundColor: getStatusColor(transaction.transaction_status) }
                                    ]}>
                                        <Text style={styles.statusText}>
                                            {getStatusIcon(transaction.transaction_status)} {transaction.transaction_status}
                                        </Text>
                                    </View>
                                </View>
                                <Text style={styles.price}>
                                    ${transaction.amount_paid.toFixed(2)}
                                </Text>
                            </View>

                            <View style={styles.transactionDetails}>
                                <View style={styles.detailRow}>
                                    <Text style={styles.detailLabel}>Credits:</Text>
                                    <Text style={styles.detailValue}>
                                        {transaction.credits_purchased}
                                    </Text>
                                </View>
                                <View style={styles.detailRow}>
                                    <Text style={styles.detailLabel}>Date:</Text>
                                    <Text style={styles.detailValue}>
                                        {formatDate(transaction.transaction_date)}
                                    </Text>
                                </View>
                                <View style={styles.detailRow}>
                                    <Text style={styles.detailLabel}>Valid From:</Text>
                                    <Text style={styles.detailValue}>
                                        {formatDate(transaction.valid_from)}
                                    </Text>
                                </View>
                                <View style={styles.detailRow}>
                                    <Text style={styles.detailLabel}>Valid Until:</Text>
                                    <Text style={styles.detailValue}>
                                        {formatDate(transaction.valid_until)}
                                    </Text>
                                </View>
                                {transaction.payment_method && (
                                    <View style={styles.detailRow}>
                                        <Text style={styles.detailLabel}>Method:</Text>
                                        <Text style={styles.detailValue}>
                                            {transaction.payment_method}
                                        </Text>
                                    </View>
                                )}
                                {transaction.transaction_id && (
                                    <View style={styles.detailRow}>
                                        <Text style={styles.detailLabel}>Transaction ID:</Text>
                                        <Text style={[styles.detailValue, styles.transactionId]}>
                                            {transaction.transaction_id}
                                        </Text>
                                    </View>
                                )}
                            </View>
                        </View>
                    ))}
                </View>
            )}

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
    },
    emptyContainer: {
        alignItems: 'center',
        paddingVertical: 60,
        paddingHorizontal: 40,
    },
    emptyIcon: {
        fontSize: 64,
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#1A1A1A',
        marginBottom: 8,
    },
    emptyText: {
        fontSize: 15,
        color: '#666',
        textAlign: 'center',
        lineHeight: 22,
    },
    transactionsContainer: {
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    transactionCard: {
        backgroundColor: '#FFFFFF',
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    transactionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 16,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#E5E5EA',
    },
    planInfo: {
        flex: 1,
    },
    planName: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1A1A1A',
        marginBottom: 6,
    },
    statusBadge: {
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 12,
        alignSelf: 'flex-start',
    },
    statusText: {
        color: '#FFF',
        fontSize: 12,
        fontWeight: '600',
        textTransform: 'capitalize',
    },
    price: {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#007AFF',
    },
    transactionDetails: {
        gap: 8,
    },
    detailRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 4,
    },
    detailLabel: {
        fontSize: 14,
        color: '#666',
    },
    detailValue: {
        fontSize: 14,
        fontWeight: '600',
        color: '#1A1A1A',
    },
    transactionId: {
        fontSize: 12,
        fontFamily: 'monospace',
        color: '#666',
    },
    bottomPadding: {
        height: 40,
    },
});
