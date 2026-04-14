import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Animated, Dimensions, Platform, View } from 'react-native';
import { Video } from 'expo-av';

const { width, height } = Dimensions.get('window');

export default function SplashScreen({ onFinish }) {
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const videoRef = useRef(null);
  const [gifDone, setGifDone] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'android') {
      // Android: let GIF play for 3.7s, then show static last frame briefly, then fade entire screen
      const doneTimer = setTimeout(() => {
        setGifDone(true); // Switch from GIF to static last frame (no animation artifacts)
      }, 3650);

      const fadeTimer = setTimeout(() => {
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }).start(() => {
          if (onFinish) onFinish();
        });
      }, 3800);

      return () => {
        clearTimeout(doneTimer);
        clearTimeout(fadeTimer);
      };
    } else {
      // iOS: smooth fade with video
      const fadeTimer = setTimeout(() => {
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 500,
          useNativeDriver: true,
        }).start(() => {
          if (onFinish) onFinish();
        });
      }, 3200);

      return () => clearTimeout(fadeTimer);
    }
  }, []);

  const handleVideoLoad = () => {
    if (videoRef.current) {
      videoRef.current.playAsync();
    }
  };

  if (Platform.OS === 'android') {
    return (
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        {gifDone ? (
          <Image
            source={require('../assets/splash_last_frame_fullscreen.jpg')}
            style={styles.fullScreen}
            resizeMode="cover"
          />
        ) : (
          <Image
            source={require('../assets/splash_animation.gif')}
            style={styles.video}
            resizeMode="contain"
          />
        )}
      </Animated.View>
    );
  }

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
  fullScreen: {
    width: width,
    height: height,
  },
});
