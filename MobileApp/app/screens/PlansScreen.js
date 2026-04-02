import React, { useState, useEffect } from 'react';
import { 
    View, 
    Text, 
    StyleSheet, 
    ScrollView, 
    ActivityIndicator, 
    TouchableOpacity,
    Alert,
    RefreshControl
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../../config';

export default function PlansScreen({ navigation }) {
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [plans, setPlans] = useState([]);
    const [currentCredits, setCurrentCredits] = useState(null);
    const [purchasing, setPurchasing] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        fetchPlans();
        fetchCurrentCredits();
    }, []);

    const fetchPlans = async () => {
        try {
            setError('');
            const response = await fetch(`${API_BASE}/plans`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to fetch plans');
            }

            if (data.success) {
                setPlans(data.plans);
            }
        } catch (err) {
            console.error('Error fetching plans:', err);
            setError(err.message || 'Failed to load plans');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    const fetchCurrentCredits = async () => {
        try {
            const token = await AsyncStorage.getItem('userToken');
            
            if (!token) {
                return;
            }

            const response = await fetch(`${API_BASE}/user/credits`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();

            if (data.success) {
                setCurrentCredits(data.credits);
            }
        } catch (err) {
            console.error('Error fetching credits:', err);
        }
    };

    const onRefresh = () => {
        setRefreshing(true);
        fetchPlans();
        fetchCurrentCredits();
    };

    const handlePurchase = async (plan) => {
        Alert.alert(
            'Confirm Purchase',
            `Purchase ${plan.credits} credits for $${plan.price.toFixed(2)}?\n\nValid for ${plan.validity_days} days.`,
            [
                {
                    text: 'Cancel',
                    style: 'cancel'
                },
                {
                    text: 'Purchase',
                    onPress: () => processPurchase(plan)
                }
            ]
        );
    };

    const processPurchase = async (plan) => {
        try {
            setPurchasing(plan.id);
            setError('');

            const token = await AsyncStorage.getItem('userToken');
            
            if (!token) {
                navigation.navigate('Login');
                return;
            }

            // NOTE: In production, this should integrate with actual payment gateway
            // For now, this is a simulated purchase
            const response = await fetch(`${API_BASE}/purchase-credits`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    planId: plan.id,
                    paymentMethod: 'simulated',
                    transactionId: `SIM-${Date.now()}`
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Purchase failed');
            }

            if (data.success) {
                Alert.alert(
                    'Purchase Successful! 🎉',
                    `${plan.credits} credits have been added to your account.\n\nRemaining: ${data.credits.remaining} credits\nExpires: ${new Date(data.credits.expiryDate).toLocaleDateString()}`,
                    [
                        {
                            text: 'OK',
                            onPress: () => {
                                fetchCurrentCredits();
                                navigation.goBack();
                            }
                        }
                    ]
                );
            }
        } catch (err) {
            console.error('Purchase error:', err);
            Alert.alert(
                'Purchase Failed',
                err.message || 'Failed to complete purchase. Please try again.',
                [{ text: 'OK' }]
            );
        } finally {
            setPurchasing(null);
        }
    };

    const renderPlanCard = (plan, index) => {
        const isPopular = plan.name === 'Professional';
        const isPurchasing = purchasing === plan.id;

        return (
            <View 
                key={plan.id} 
                style={[
                    styles.planCard,
                    isPopular && styles.popularCard
                ]}
            >
                {isPopular && (
                    <View style={styles.popularBadge}>
                        <Text style={styles.popularBadgeText}>MOST POPULAR</Text>
                    </View>
                )}

                <Text style={styles.planName}>{plan.name}</Text>
                
                <View style={styles.priceContainer}>
                    <Text style={styles.currencySymbol}>$</Text>
                    <Text style={styles.price}>{plan.price.toFixed(2)}</Text>
                </View>

                <Text style={styles.creditsText}>{plan.credits} Credits</Text>
                <Text style={styles.validityText}>Valid for {plan.validity_days} days</Text>

                {plan.description && (
                    <Text style={styles.description}>{plan.description}</Text>
                )}

                <View style={styles.featuresContainer}>
                    {plan.features && plan.features.map((feature, i) => (
                        <View key={i} style={styles.featureItem}>
                            <Text style={styles.featureIcon}>✓</Text>
                            <Text style={styles.featureText}>{feature}</Text>
                        </View>
                    ))}
                </View>

                <TouchableOpacity
                    style={[
                        styles.purchaseButton,
                        isPopular && styles.popularButton,
                        isPurchasing && styles.disabledButton
                    ]}
                    onPress={() => handlePurchase(plan)}
                    disabled={isPurchasing}
                >
                    {isPurchasing ? (
                        <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                        <Text style={styles.purchaseButtonText}>
                            {isPopular ? 'Get Started' : 'Purchase Plan'}
                        </Text>
                    )}
                </TouchableOpacity>

                <Text style={styles.pricePerCredit}>
                    ${(plan.price / plan.credits).toFixed(2)} per credit
                </Text>
            </View>
        );
    };

    if (loading) {
        return (
            <View style={styles.centerContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>Loading plans...</Text>
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
                <Text style={styles.headerTitle}>Choose Your Plan</Text>
                <Text style={styles.headerSubtitle}>
                    Generate professional cover letters with AI
                </Text>
            </View>

            {/* Current Credits Badge */}
            {currentCredits && (
                <View style={styles.currentCreditsContainer}>
                    <View style={styles.currentCreditsCard}>
                        <Text style={styles.currentCreditsLabel}>Current Balance</Text>
                        <Text style={styles.currentCreditsValue}>
                            {currentCredits.remaining} credits
                        </Text>
                        {currentCredits.expiryDate && (
                            <Text style={styles.currentCreditsExpiry}>
                                Expires: {new Date(currentCredits.expiryDate).toLocaleDateString()}
                            </Text>
                        )}
                    </View>
                </View>
            )}

            {error ? (
                <View style={styles.errorContainer}>
                    <Text style={styles.errorText}>{error}</Text>
                    <TouchableOpacity style={styles.retryButton} onPress={fetchPlans}>
                        <Text style={styles.retryButtonText}>Retry</Text>
                    </TouchableOpacity>
                </View>
            ) : null}

            {/* Plans Grid */}
            <View style={styles.plansContainer}>
                {plans.map((plan, index) => renderPlanCard(plan, index))}
            </View>

            {/* Info Section */}
            <View style={styles.infoCard}>
                <Text style={styles.infoTitle}>💡 How Credits Work</Text>
                <View style={styles.infoItem}>
                    <Text style={styles.infoIcon}>•</Text>
                    <Text style={styles.infoText}>
                        Each cover letter generation costs 1 credit
                    </Text>
                </View>
                <View style={styles.infoItem}>
                    <Text style={styles.infoIcon}>•</Text>
                    <Text style={styles.infoText}>
                        Credits are valid for the specified number of days
                    </Text>
                </View>
                <View style={styles.infoItem}>
                    <Text style={styles.infoIcon}>•</Text>
                    <Text style={styles.infoText}>
                        Unused credits expire at the end of validity period
                    </Text>
                </View>
                <View style={styles.infoItem}>
                    <Text style={styles.infoIcon}>•</Text>
                    <Text style={styles.infoText}>
                        AI-powered personalized cover letters for each company
                    </Text>
                </View>
            </View>

            {/* Note about payment integration */}
            <View style={styles.noteContainer}>
                <Text style={styles.noteText}>
                    ℹ️ Note: This is currently a simulated purchase for development purposes. 
                    In production, this will integrate with a secure payment gateway.
                </Text>
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
        paddingVertical: 32,
        paddingHorizontal: 20,
        backgroundColor: '#007AFF',
        alignItems: 'center',
    },
    headerTitle: {
        fontSize: 32,
        fontWeight: 'bold',
        color: '#FFFFFF',
        marginBottom: 8,
        textAlign: 'center',
    },
    headerSubtitle: {
        fontSize: 16,
        color: '#FFFFFF',
        opacity: 0.9,
        textAlign: 'center',
    },
    currentCreditsContainer: {
        marginHorizontal: 16,
        marginTop: -20,
        marginBottom: 16,
    },
    currentCreditsCard: {
        backgroundColor: '#FFFFFF',
        padding: 20,
        borderRadius: 12,
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 8,
        elevation: 5,
    },
    currentCreditsLabel: {
        fontSize: 14,
        color: '#666',
        marginBottom: 4,
    },
    currentCreditsValue: {
        fontSize: 28,
        fontWeight: 'bold',
        color: '#007AFF',
    },
    currentCreditsExpiry: {
        fontSize: 12,
        color: '#999',
        marginTop: 4,
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
    plansContainer: {
        paddingHorizontal: 16,
    },
    planCard: {
        backgroundColor: '#FFFFFF',
        borderRadius: 16,
        padding: 24,
        marginBottom: 16,
        borderWidth: 2,
        borderColor: '#E5E5EA',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    popularCard: {
        borderColor: '#34C759',
        borderWidth: 3,
        transform: [{ scale: 1.02 }],
    },
    popularBadge: {
        position: 'absolute',
        top: -12,
        right: 20,
        backgroundColor: '#34C759',
        paddingVertical: 6,
        paddingHorizontal: 16,
        borderRadius: 12,
    },
    popularBadgeText: {
        color: '#FFF',
        fontSize: 12,
        fontWeight: 'bold',
    },
    planName: {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#1A1A1A',
        marginBottom: 12,
    },
    priceContainer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 8,
    },
    currencySymbol: {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#007AFF',
        marginTop: 8,
    },
    price: {
        fontSize: 48,
        fontWeight: 'bold',
        color: '#007AFF',
    },
    creditsText: {
        fontSize: 20,
        fontWeight: '600',
        color: '#1A1A1A',
        marginBottom: 4,
    },
    validityText: {
        fontSize: 14,
        color: '#666',
        marginBottom: 12,
    },
    description: {
        fontSize: 14,
        color: '#666',
        marginBottom: 16,
        lineHeight: 20,
    },
    featuresContainer: {
        marginBottom: 20,
    },
    featureItem: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    featureIcon: {
        fontSize: 18,
        color: '#34C759',
        marginRight: 8,
        fontWeight: 'bold',
    },
    featureText: {
        fontSize: 14,
        color: '#333',
        flex: 1,
    },
    purchaseButton: {
        backgroundColor: '#007AFF',
        paddingVertical: 16,
        borderRadius: 12,
        alignItems: 'center',
        marginBottom: 8,
    },
    popularButton: {
        backgroundColor: '#34C759',
    },
    disabledButton: {
        opacity: 0.6,
    },
    purchaseButtonText: {
        color: '#FFF',
        fontSize: 18,
        fontWeight: 'bold',
    },
    pricePerCredit: {
        fontSize: 12,
        color: '#999',
        textAlign: 'center',
    },
    infoCard: {
        backgroundColor: '#E3F2FD',
        marginHorizontal: 16,
        marginTop: 8,
        padding: 20,
        borderRadius: 12,
    },
    infoTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1A1A1A',
        marginBottom: 12,
    },
    infoItem: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 8,
    },
    infoIcon: {
        fontSize: 16,
        color: '#007AFF',
        marginRight: 8,
        marginTop: 2,
    },
    infoText: {
        fontSize: 14,
        color: '#333',
        flex: 1,
        lineHeight: 20,
    },
    noteContainer: {
        backgroundColor: '#FFF9C4',
        marginHorizontal: 16,
        marginTop: 16,
        padding: 16,
        borderRadius: 12,
        borderLeftWidth: 4,
        borderLeftColor: '#FFC107',
    },
    noteText: {
        fontSize: 13,
        color: '#856404',
        lineHeight: 18,
    },
    bottomPadding: {
        height: 40,
    },
});
