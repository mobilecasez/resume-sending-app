import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const TIPS = [
  "AI prioritizes jobs where your skills match the requirements strongly.",
  "A customized cover letter increases interview chances by 40%.",
  "Soft skills are just as important as technical skills for senior roles.",
  "Tailor your resume summary for the specific industry of the company.",
  "Follow up within 48 hours after submitting your application.",
  "Most recruiters spend only 6-8 seconds looking at a resume initially."
];

export function LoadingTips() {
  const [tipIndex, setTipIndex] = useState(0);
  const [displayedText, setDisplayedText] = useState('');
  const [showCursor, setShowCursor] = useState(true);
  
  const floatAnim = useRef(new Animated.Value(0)).current;

  // Floating animation for the icon
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: -4,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [floatAnim]);

  // Blinking cursor
  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 500);
    return () => clearInterval(cursorInterval);
  }, []);

  // Typing effect
  useEffect(() => {
    const fullText = "Tip: " + TIPS[tipIndex];
    let currentIndex = 0;
    setDisplayedText('');

    const typingInterval = setInterval(() => {
      if (currentIndex < fullText.length) {
        setDisplayedText(fullText.slice(0, currentIndex + 1));
        currentIndex++;
      } else {
        clearInterval(typingInterval);
        // Wait 3.5 seconds before moving to the next tip
        setTimeout(() => {
          setTipIndex((prev) => (prev + 1) % TIPS.length);
        }, 3500);
      }
    }, 45); // typing speed

    return () => clearInterval(typingInterval);
  }, [tipIndex]);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.iconContainer, { transform: [{ translateY: floatAnim }] }]}>
        <Ionicons name="sparkles" size={18} color="#8B5CF6" />
      </Animated.View>
      <View style={styles.textContainer}>
        <Text style={styles.text}>
          {displayedText}
          <Text style={{ opacity: showCursor ? 1 : 0, color: '#8B5CF6' }}>|</Text>
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F5F3FF', // Light violet background
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#EDE9FE',
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#EDE9FE',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  textContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  text: {
    fontSize: 14,
    color: '#5B21B6',
    fontWeight: '600',
    lineHeight: 22,
  }
});
