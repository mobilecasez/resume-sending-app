import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Dimensions } from 'react-native';
import { Video } from 'expo-av';

const { width, height } = Dimensions.get('window');

export default function SplashScreen({ onFinish }) {
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const videoRef = useRef(null);

  useEffect(() => {
    // Start fade out after video finishes (8 seconds)
    const timer = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }).start(() => {
        if (onFinish) {
          onFinish();
        }
      });
    }, 7500); // Start fade at 7.5s (before 8s video ends)

    return () => clearTimeout(timer);
  }, []);

  const handleVideoLoad = () => {
    if (videoRef.current) {
      videoRef.current.playAsync();
    }
  };

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <Video
        ref={videoRef}
        source={require('../assets/splash_animation.mp4')}
        rate={1.0}
        volume={0}
        isMuted={true}
        resizeMode="contain"
        shouldPlay
        isLooping={false}
        style={styles.video}
        onLoad={handleVideoLoad}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
  },
  video: {
    width: Math.min(width * 0.8, 480),
    height: Math.min(height * 0.5, 270),
  },
});
