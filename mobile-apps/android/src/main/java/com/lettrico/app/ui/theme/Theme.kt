package com.lettrico.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Primary colors matching web app
private val PrimaryBlue = Color(0xFF1E40AF)
private val LightBlue = Color(0xFF3B82F6)
private val DarkBlue = Color(0xFF0C2340)
private val GreenAccent = Color(0xFF059669)
private val RedError = Color(0xFFEF4444)
private val Gray = Color(0xFF6B7280)
private val LightGray = Color(0xFFF3F4F6)
private val White = Color(0xFFFFFFFF)

private val lightColorScheme = lightColorScheme(
    primary = PrimaryBlue,
    secondary = GreenAccent,
    tertiary = LightBlue,
    background = White,
    surface = LightGray,
    onBackground = Color.Black,
    onSurface = Color.Black,
    error = RedError
)

private val darkColorScheme = darkColorScheme(
    primary = LightBlue,
    secondary = GreenAccent,
    tertiary = PrimaryBlue,
    background = DarkBlue,
    surface = Color(0xFF1F2937),
    onBackground = White,
    onSurface = White,
    error = RedError
)

@Composable
fun LettricoTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) darkColorScheme else lightColorScheme
    
    MaterialTheme(
        colorScheme = colorScheme,
        typography = LettrionTypography,
        content = content
    )
}
