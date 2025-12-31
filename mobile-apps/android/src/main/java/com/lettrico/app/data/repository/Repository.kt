package com.lettrico.app.data.repository

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.lettrico.app.data.api.ApiService
import com.lettrico.app.data.api.LoginRequest
import com.lettrico.app.data.api.RegisterRequest
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore("lettrico_prefs")

class AuthRepository(private val apiService: ApiService) {
    
    suspend fun login(email: String, password: String) = try {
        val request = LoginRequest(email, password)
        Result.success(apiService.login(request))
    } catch (e: Exception) {
        Result.failure(e)
    }
    
    suspend fun register(fullName: String, email: String, password: String) = try {
        val request = RegisterRequest(fullName, email, password)
        Result.success(apiService.register(request))
    } catch (e: Exception) {
        Result.failure(e)
    }
    
    suspend fun saveAuthToken(context: Context, token: String) {
        context.dataStore.edit { preferences ->
            preferences[stringPreferencesKey("auth_token")] = token
        }
    }
    
    fun getAuthToken(context: Context) = context.dataStore.data.map { preferences ->
        preferences[stringPreferencesKey("auth_token")]
    }
    
    suspend fun logout(context: Context) {
        context.dataStore.edit { preferences ->
            preferences.remove(stringPreferencesKey("auth_token"))
            preferences.remove(stringPreferencesKey("user_data"))
        }
    }
}

class CoverLetterRepository(private val apiService: ApiService) {
    
    suspend fun generateCoverLetter(
        token: String,
        userId: Int,
        companyName: String,
        position: String,
        websiteUrl: String,
        recipientEmail: String
    ) = try {
        val request = com.lettrico.app.data.api.GenerateCoverLetterRequest(
            userId, companyName, position, websiteUrl, recipientEmail
        )
        Result.success(apiService.generateCoverLetter("Bearer $token", request))
    } catch (e: Exception) {
        Result.failure(e)
    }
}
