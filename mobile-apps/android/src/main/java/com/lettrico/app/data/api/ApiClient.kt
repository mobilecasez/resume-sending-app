package com.lettrico.app.data.api

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.http.*

interface ApiService {
    @POST("/api/auth/login")
    suspend fun login(@Body request: LoginRequest): AuthResponse
    
    @POST("/api/auth/register")
    suspend fun register(@Body request: RegisterRequest): AuthResponse
    
    @GET("/api/user/profile")
    suspend fun getUserProfile(@Header("Authorization") token: String): User
    
    @PUT("/api/user/profile")
    suspend fun updateUserProfile(
        @Header("Authorization") token: String,
        @Body user: User
    ): User
    
    @POST("/api/cover-letter/generate")
    suspend fun generateCoverLetter(
        @Header("Authorization") token: String,
        @Body request: GenerateCoverLetterRequest
    ): CoverLetter
}

object ApiClient {
    private const val BASE_URL = "http://localhost:3000"
    
    fun createApiService(): ApiService {
        val json = Json {
            ignoreUnknownKeys = true
            coerceInputValues = true
        }
        
        val logging = HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BODY
        }
        
        val httpClient = OkHttpClient.Builder()
            .addInterceptor(logging)
            .build()
        
        val contentType = "application/json".toMediaType()
        
        return Retrofit.Builder()
            .baseUrl(BASE_URL)
            .client(httpClient)
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()
            .create(ApiService::class.java)
    }
}
